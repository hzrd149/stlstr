import {
  createShellBridge,
  originRegistry,
  prepareNappletSrcdoc,
  resolveShellEnvironment,
  denyNappletControllerAccess,
} from '@kehto/shell';
import {
  createKehtoShellAdapter,
  createKehtoOutboxService,
  createKehtoCountService,
  createKehtoCommonService,
  createKehtoListsService,
  createKehtoUploadService,
  type KehtoContext,
} from 'applesauce-extra/kehto';
import { createStlstrIdentityService } from './identity';
import { createThemeService } from '@kehto/services';
import { Observable } from 'rxjs';
import { accountManager } from './accounts';
import { eventStore, relayPool, getUser, STLSTR_LOCAL_MODE } from './nostr';
import {
  getAppRelays,
  getLookupRelays,
  getFallbackBlossomServers,
  getSettings,
  subscribeToSettings,
} from './settings';
import { loadNappletArtifact, type ResolvedNapplet, type LoadedNapplet } from './napplets';
import { createStlstrIntentService } from './intent';
import { createStlstrLinkService } from './links';
import { createStlstrResourceService } from './resource';
import { sealNappletFrame } from './sandbox';
import type { IntentDelivery } from './intent-delivery';
import type { IntentNavigation } from './intent-map';

type ShellNavigate = (href: string, navigation?: IntentNavigation) => void;

/**
 * The shell's navigate function, registered by the always-mounted shell layout. Held here
 * rather than captured from whichever frame first created the shared host: that frame can
 * unmount while another (the preview) keeps the host alive, and its navigate would then
 * act on a stale location.
 */
let shellNavigate: ShellNavigate | null = null;

/** Registers the live shell navigate function; returns an unregister callback. */
export function setShellNavigate(navigate: ShellNavigate): () => void {
  shellNavigate = navigate;
  return () => {
    if (shellNavigate === navigate) shellNavigate = null;
  };
}

function settingsValue<T>(read: () => T) {
  return new Observable<T>((subscriber) => {
    subscriber.next(read());
    return subscribeToSettings(() => subscriber.next(read()));
  });
}

// Local mode pins every adapter pool operation, including NIP-65-selected destinations.
const localPool = new Proxy(relayPool, {
  get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => {
      if (
        ['subscription', 'request', 'req', 'publish', 'event', 'count', 'group'].includes(
          String(key),
        )
      )
        args[0] = getAppRelays();
      if (key === 'relay') args[0] = getAppRelays()[0];
      return Reflect.apply(value, target, args);
    };
  },
});

function createHost() {
  const frames = new Map<
    string,
    {
      frame: HTMLIFrameElement;
      loaded: LoadedNapplet;
      delivery: IntentDelivery;
      fail: (reason: string) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const identities = new Map<string, string[]>();
  const context: KehtoContext = {
    eventStore,
    pool: STLSTR_LOCAL_MODE ? localPool : relayPool,
    signer: accountManager.active$,
    fallbackRelays: settingsValue(getAppRelays),
    fallbackBlossomServers: settingsValue(getFallbackBlossomServers),
  };
  const getActiveUser = () =>
    accountManager.active ? getUser(accountManager.active.pubkey) : null;
  const getTheme = () => {
    const css = getComputedStyle(document.documentElement);
    return {
      colors: {
        background: css.getPropertyValue('--color-base-100').trim(),
        text: css.getPropertyValue('--color-base-content').trim(),
        primary: css.getPropertyValue('--color-primary').trim(),
      },
    };
  };
  const theme = createThemeService({
    initialTheme: getTheme(),
    onBroadcast: (envelope) => bridge.publishTheme(envelope.theme),
  });
  const adapter = createKehtoShellAdapter(context, {
    services: {
      identity: createStlstrIdentityService(context),
      outbox: createKehtoOutboxService(context),
      count: createKehtoCountService(context),
      common: createKehtoCommonService(context),
      lists: createKehtoListsService(context),
      upload: createKehtoUploadService(context),
      resource: createStlstrResourceService({
        getActiveUser,
        resolveIdentity: (id) => {
          const loaded = frames.get(id)?.loaded;
          return loaded ? { dTag: loaded.dTag, aggregateHash: loaded.aggregateHash } : null;
        },
      }),
      intent: createStlstrIntentService({
        navigate: (href, navigation) => shellNavigate?.(href, navigation),
        resolveSender: (id) => frames.get(id)?.loaded.catalogId,
      }),
      link: createStlstrLinkService(),
      theme: theme.handler,
    },
    overrides: {
      config: { getNappUpdateBehavior: () => getSettings().nappletUpdateBehavior },
      relayConfig: {
        getRelayConfig: () => ({
          discovery: getLookupRelays(),
          super: getAppRelays(),
          outbox: getAppRelays(),
        }),
      },
      capabilities: {
        resolveEnvironment: (identity, available) => {
          const allowed = new Set([
            'shell',
            ...(identities.get(`${identity.dTag}:${identity.aggregateHash}`) ?? []),
          ]);
          return {
            domains: available.domains.filter((domain) => allowed.has(domain)),
            services: available.services.filter((domain) => allowed.has(domain)),
          };
        },
      },
      onNappletMessage: (id, message) => {
        const entry = frames.get(id);
        if (entry && message.type === 'shell.ready') {
          clearTimeout(entry.timer);
          entry.frame.dataset.nappletReady = 'true';
          // The frame's port is bound now; NAP-INTENT delivers only to a ready target.
          // A napplet that did not declare `intent` has no delivery binding to receive it.
          if (entry.loaded.domains.includes('intent')) entry.delivery.markReady();
          else console.warn(`[stlstr] ${entry.loaded.dTag} does not declare intent`);
        }
      },
      onNappletRevoked: ({ windowId, detail }) => {
        const entry = frames.get(windowId);
        if (entry) clearTimeout(entry.timer);
        entry?.fail(detail);
      },
      onUnroutedMessage: (info) => console.warn('[stlstr] dropped napplet message', info),
    },
  });
  const bridge = createShellBridge(adapter);
  bridge.registerConsentHandler((request) => {
    request.resolve(window.confirm('Allow this napplet to perform the requested action?'));
  });
  window.addEventListener('message', bridge.handleMessage);
  const accountSubscription = accountManager.active$.subscribe((account) =>
    bridge.publishIdentityChanged(account?.pubkey ?? ''),
  );
  const themeObserver = new MutationObserver(() => theme.publishTheme(getTheme()));
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'class'],
  });

  return {
    async mount(
      napplet: ResolvedNapplet,
      frame: HTMLIFrameElement,
      delivery: IntentDelivery,
      signal: AbortSignal,
      fail: (reason: string) => void,
    ) {
      const loaded = await loadNappletArtifact(napplet);
      if (signal.aborted) return;
      const id = `napplet-${crypto.randomUUID()}`;
      delete frame.dataset.nappletReady;
      identities.set(`${loaded.dTag}:${loaded.aggregateHash}`, loaded.domains);
      const timer = setTimeout(() => {
        fail('Napplet initialization timed out. Try reloading the page.');
        bridge.revokeNapplet(id);
      }, 10_000);
      frames.set(id, { frame, loaded, delivery, fail, timer });
      const identity = { dTag: loaded.dTag, aggregateHash: loaded.aggregateHash };
      originRegistry.register(frame.contentWindow!, id, identity);
      const environment = resolveShellEnvironment(adapter, identity);
      originRegistry.setEnvironment(frame.contentWindow!, environment);
      denyNappletControllerAccess(frame);
      const stopObserving = bridge.observeFrame(frame, id);
      signal.addEventListener(
        'abort',
        () => {
          stopObserving();
          clearTimeout(timer);
          frames.delete(id);
          if (
            ![...frames.values()].some(
              (entry) =>
                entry.loaded.dTag === loaded.dTag &&
                entry.loaded.aggregateHash === loaded.aggregateHash,
            )
          ) {
            identities.delete(`${loaded.dTag}:${loaded.aggregateHash}`);
          }
          bridge.revokeNapplet(id);
          bridge.runtime.destroyWindow(id);
          bridge.runtime.sessionRegistry.unregister(id);
          originRegistry.unregister(id);
        },
        { once: true },
      );
      frame.srcdoc = sealNappletFrame(
        prepareNappletSrcdoc(loaded.html, { domains: environment.capabilities.domains }),
      );
    },
    send(frame: HTMLIFrameElement | null, message: unknown) {
      const id = frame?.contentWindow && originRegistry.getWindowId(frame.contentWindow);
      if (id) originRegistry.postToNapplet(id, message);
    },
    destroy() {
      window.removeEventListener('message', bridge.handleMessage);
      accountSubscription.unsubscribe();
      themeObserver.disconnect();
      bridge.destroy();
      adapter.stop({ services: false });
    },
  };
}

let shared: ReturnType<typeof createHost> | undefined;
let users = 0;
export function acquireNappletHost() {
  const host = (shared ??= createHost());
  users++;
  return {
    host,
    release() {
      if (--users === 0) {
        host.destroy();
        shared = undefined;
      }
    },
  };
}
