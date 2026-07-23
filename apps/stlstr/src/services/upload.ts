import type { NappletMessage, NostrTag, UploadInfo, UploadResult, UploadStatus } from '@napplet/core';
import type {
  UploadInfoMessage,
  UploadStatusMessage,
  UploadUploadMessage,
} from '@napplet/nap/upload/types';
import type { ServiceHandler } from '@kehto/runtime';
import type { User } from 'applesauce-common/casts';
import type { ISigner } from 'applesauce-signers';
import { Actions, createUploadAuth } from 'blossom-client-sdk';
import type { BlobDescriptor, EventTemplate, SignedEvent, UploadType } from 'blossom-client-sdk';
import { STLSTR_DEV_BLOSSOM_SERVER, STLSTR_DEV_MODE } from './nostr';

type ObservableLike<T> = {
  subscribe(observer: (value: T) => void): { unsubscribe(): void };
};

type UploadRecord = UploadStatus & {
  windowId: string;
};

export type UploadServiceOptions = {
  getActiveUser: () => User | null;
  getSigner: () => ISigner | null;
};

function firstDefinedValue<T>(observable: ObservableLike<T | undefined>, timeoutMs = 1_500) {
  return new Promise<T | undefined>((resolve) => {
    let settled = false;
    const subscription = observable.subscribe((value) => {
      if (value === undefined || settled) return;
      settled = true;
      window.clearTimeout(timeout);
      subscription.unsubscribe();
      resolve(value);
    });

    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      subscription.unsubscribe();
      resolve(undefined);
    }, timeoutMs);
  });
}

function normalizeServerUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function uniqueServers(servers: Iterable<string | URL | undefined>): string[] {
  const unique = new Set<string>();
  for (const server of servers) {
    if (!server) continue;
    const normalized = normalizeServerUrl(String(server));
    if (normalized) unique.add(normalized);
  }
  return [...unique];
}

async function getBlossomServers(user: User | null): Promise<string[]> {
  if (STLSTR_DEV_MODE) return [STLSTR_DEV_BLOSSOM_SERVER];
  if (!user) return [];
  return uniqueServers((await firstDefinedValue(user.blossomServers$)) ?? []);
}

async function requestToBlob(message: UploadUploadMessage): Promise<UploadType> {
  const { request } = message;
  if (request.data instanceof Blob) {
    if (request.data instanceof File) return request.data;
    return new File([request.data], request.filename || 'upload', {
      type: request.mimeType || request.data.type || 'application/octet-stream',
    });
  }

  return new File([request.data], request.filename || 'upload', {
    type: request.mimeType || 'application/octet-stream',
  });
}

function uploadTags(blob: BlobDescriptor): NostrTag[] {
  const tags: NostrTag[] = [
    ['url', blob.url],
    ['x', blob.sha256],
    ['size', String(blob.size)],
  ];
  if (blob.type) tags.push(['m', blob.type]);
  return tags;
}

function uploadResultFromBlob(uploadId: string, blobs: BlobDescriptor[]): UploadResult {
  const [primary, ...fallbacks] = blobs;
  return {
    ok: true,
    uploadId,
    status: 'complete',
    rail: 'blossom',
    url: primary.url,
    fallbackUrls: fallbacks.map((blob) => blob.url),
    sha256: primary.sha256,
    size: primary.size,
    mimeType: primary.type,
    nip94: uploadTags(primary),
  };
}

function failedUpload(uploadId: string, error: string): UploadResult {
  return { ok: false, uploadId, status: 'failed', rail: 'blossom', error };
}

function createStatus(windowId: string, result: UploadResult): UploadRecord {
  return { ...result, windowId, updatedAt: Date.now() };
}

function signerAdapter(signer: ISigner) {
  return async (draft: EventTemplate): Promise<SignedEvent> => {
    return (await signer.signEvent(draft)) as SignedEvent;
  };
}

export function createUploadService({ getActiveUser, getSigner }: UploadServiceOptions): ServiceHandler {
  const uploads = new Map<string, UploadRecord>();

  function sendStatus(status: UploadRecord, send: (msg: NappletMessage) => void) {
    send({ type: 'upload.status.changed', status } as NappletMessage);
  }

  async function handleUpload(windowId: string, message: UploadUploadMessage, send: (msg: NappletMessage) => void) {
    const uploadId = `${windowId}-${message.id}`;
    const signer = getSigner();
    if (!signer) {
      const result = failedUpload(uploadId, 'Login required to upload files.');
      uploads.set(uploadId, createStatus(windowId, result));
      send({ type: 'upload.upload.result', id: message.id, result, error: result.error } as NappletMessage);
      return;
    }

    if (message.request.rail && message.request.rail !== 'blossom') {
      const result = failedUpload(uploadId, `Unsupported upload rail: ${message.request.rail}`);
      uploads.set(uploadId, createStatus(windowId, result));
      send({ type: 'upload.upload.result', id: message.id, result, error: result.error } as NappletMessage);
      return;
    }

    const servers = await getBlossomServers(getActiveUser());
    if (servers.length === 0) {
      const result = failedUpload(uploadId, 'No Blossom servers are configured for this account.');
      uploads.set(uploadId, createStatus(windowId, result));
      send({ type: 'upload.upload.result', id: message.id, result, error: result.error } as NappletMessage);
      return;
    }

    const pending = createStatus(windowId, {
      ok: true,
      uploadId,
      status: 'uploading',
      rail: 'blossom',
    });
    uploads.set(uploadId, pending);
    sendStatus(pending, send);

    try {
      const blob = await requestToBlob(message);
      const authSigner = signerAdapter(signer);
      const errors: string[] = [];
      const resultMap = await Actions.multiServerUpload(servers, blob, {
        onAuth: async (_server: string, sha256: string, type?: 'upload' | 'media') =>
          createUploadAuth(authSigner, sha256, { type, message: message.request.caption }),
        onError: (server: string, _sha256: string, _blob: UploadType, error: Error) => {
          errors.push(`${server}: ${error.message}`);
        },
        onRejection: (server: string, _sha256: string, _blob: UploadType, error: Error) => {
          errors.push(`${server}: ${error.message}`);
          return 'skip';
        },
      });

      const descriptors = servers
        .map((server) => resultMap.get(server))
        .filter((descriptor): descriptor is BlobDescriptor => Boolean(descriptor));

      if (descriptors.length === 0) {
        throw new Error(errors[0] ?? 'All Blossom servers rejected the upload.');
      }

      const result = uploadResultFromBlob(uploadId, descriptors);
      if (errors.length > 0 && descriptors.length < servers.length) {
        result.error = `Uploaded to ${descriptors.length}/${servers.length} servers. ${errors.join('; ')}`;
      }
      const status = createStatus(windowId, result);
      uploads.set(uploadId, status);
      sendStatus(status, send);
      send({ type: 'upload.upload.result', id: message.id, result } as NappletMessage);
    } catch (cause) {
      const result = failedUpload(uploadId, cause instanceof Error ? cause.message : 'Upload failed.');
      const status = createStatus(windowId, result);
      uploads.set(uploadId, status);
      sendStatus(status, send);
      send({ type: 'upload.upload.result', id: message.id, result, error: result.error } as NappletMessage);
    }
  }

  return {
    descriptor: { name: 'upload', version: '0.1.0', description: 'stlstr Blossom upload service' },
    handleMessage(windowId, message, send) {
      if (message.type === 'upload.info') {
        const info: UploadInfo = {
          rails: [{ rail: 'blossom', enabled: true, returns: ['url', 'fallbackUrls', 'sha256', 'size', 'mimeType', 'nip94'] }],
        };
        send({ type: 'upload.info.result', id: (message as UploadInfoMessage).id, info } as NappletMessage);
      } else if (message.type === 'upload.upload') {
        void handleUpload(windowId, message as UploadUploadMessage, send);
      } else if (message.type === 'upload.status') {
        const statusMessage = message as UploadStatusMessage;
        const status = uploads.get(statusMessage.uploadId);
        send({
          type: 'upload.status.result',
          id: statusMessage.id,
          status: status && status.windowId === windowId ? status : undefined,
          error: status ? undefined : 'Unknown upload.',
        } as NappletMessage);
      }
    },
    onWindowDestroyed(windowId) {
      for (const [uploadId, upload] of uploads) {
        if (upload.windowId === windowId) uploads.delete(uploadId);
      }
    },
  };
}
