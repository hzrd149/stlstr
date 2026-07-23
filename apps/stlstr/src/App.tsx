import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import {
  createShellBridge,
  injectNappletNamespacePrelude,
  originRegistry,
  type ShellAdapter,
  type ShellBridge,
} from '@kehto/shell';
import { NostrConnectAccount } from 'applesauce-accounts/accounts';
import { getDisplayName, getProfilePicture } from 'applesauce-core/helpers';
import { use$ } from 'applesauce-react/hooks';
import { NostrConnectSigner } from 'applesauce-signers/signers';
import { verifyEvent } from 'nostr-tools';
import { toDataURL } from 'qrcode';
import {
  Link,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router';
import {
  accountManager,
  accountManagerReady,
  createNostrConnectLogin,
  finishNostrConnectLogin,
  loginWithBunkerUri,
  loginWithExtension,
  type StlstrAccount,
} from './services/accounts';
import { createCountService } from './services/count';
import { createStlstrIdentityService } from './services/identity';
import { createIntentDelivery, type IntentDelivery } from './services/intent-delivery';
import { createStlstrIntentService } from './services/intent';
import { createStlstrLinkService } from './services/links';
import { sealNappletFrame } from './services/sandbox';
import {
  baseHref,
  hasPreview,
  overlayFromLocation,
  type StlstrIntent,
} from './services/intent-map';
import { STLSTR_DEV_MODE, getUser, relayPool } from './services/nostr';
import { createOutboxService } from './services/outbox';
import { createStlstrResourceService } from './services/resource';
import { getAppRelays, getLookupRelays, getSettings } from './services/settings';
import { createUploadService } from './services/upload';
import SettingsView from './SettingsView';

declare global {
  interface Window {
    nostr?: unknown;
  }
}

type DevNapplet = {
  name: string;
  url: string;
};

type DevRegistry = {
  napplets?: DevNapplet[];
};

type AdapterOptions = {
  /** Pushes a shell route. NAP-INTENT resolves archetypes by navigating the shell. */
  navigate: (href: string) => void;
  /** Resolves a napplet window to its NIP-5D identity for NAP-RESOURCE grant checks. */
  resolveIdentity: (windowId: string) => { dTag: string; aggregateHash: string } | null;
};

function createStlstrAdapter({ navigate, resolveIdentity }: AdapterOptions): ShellAdapter {
  const subscriptions = new Map<string, () => void>();

  const getActiveUser = () => {
    const pubkey = accountManager.active?.pubkey;
    return pubkey ? getUser(pubkey) : null;
  };
  const routeRelayUrls = (relayUrls: string[]) => (STLSTR_DEV_MODE ? getAppRelays() : relayUrls);

  return {
    relayPool: {
      getRelayPool: () => ({
        subscription: (relayUrls, filters) =>
          relayPool.subscription(routeRelayUrls(relayUrls), filters),
        publish: (relayUrls, event) => {
          void relayPool.publish(routeRelayUrls(relayUrls), event);
        },
        request: (relayUrls, filters) => relayPool.request(routeRelayUrls(relayUrls), filters),
      }),
      trackSubscription: (key, cleanup) => subscriptions.set(key, cleanup),
      untrackSubscription: (key) => {
        subscriptions.get(key)?.();
        subscriptions.delete(key);
      },
      openScopedRelay: () => {},
      closeScopedRelay: () => {},
      publishToScopedRelay: () => false,
      selectRelayTier: () => getAppRelays(),
    },
    relayConfig: {
      // Relay lists are owned by the settings view; napplets only read them.
      addRelay: () => {},
      removeRelay: () => {},
      getRelayConfig: () => ({
        discovery: getLookupRelays(),
        super: getAppRelays(),
        outbox: getAppRelays(),
      }),
      getNip66Suggestions: () => [],
    },
    windowManager: {
      createWindow: () => null,
    },
    auth: {
      getUserPubkey: () => accountManager.active?.pubkey ?? null,
      getSigner: () => accountManager.active?.signer ?? null,
    },
    config: {
      getNappUpdateBehavior: () => getSettings().nappletUpdateBehavior,
    },
    hotkeys: {
      executeHotkeyFromForward: () => {},
    },
    workerRelay: {
      getWorkerRelay: () => null,
    },
    crypto: {
      verifyEvent: async (event) => verifyEvent(event),
    },
    upload: {
      getUploader: () => ({ rails: ['blossom'] }),
    },
    services: {
      outbox: createOutboxService({
        getActiveUser,
        getSigner: () => accountManager.active?.signer ?? null,
      }),
      upload: createUploadService({
        getActiveUser,
        getSigner: () => accountManager.active?.signer ?? null,
      }),
      resource: createStlstrResourceService({ resolveIdentity }),
      intent: createStlstrIntentService({ navigate }),
      // NAP-IDENTITY is read-only: napplets learn who the user is, never act as them.
      // This is what lets a napplet gate an owner-only action such as "Edit".
      identity: createStlstrIdentityService({
        getSigner: () => accountManager.active?.signer ?? null,
      }),
      link: createStlstrLinkService(),
      count: createCountService(),
    },
    onUnroutedMessage: (info) => {
      console.warn('[stlstr] dropped napplet message', info);
    },
  };
}

async function resolveNappletUrl(name: string, fallbackUrl: string): Promise<string> {
  try {
    const response = await fetch('/napplets.dev.json', { cache: 'no-store' });
    if (!response.ok) return fallbackUrl;

    const registry = (await response.json()) as DevRegistry;
    return registry.napplets?.find((napplet) => napplet.name === name)?.url ?? fallbackUrl;
  } catch {
    return fallbackUrl;
  }
}

/**
 * Read the NAP domains a napplet declares in its NIP-5A manifest meta tag.
 *
 * Each napplet's `nip5aManifest({ requires })` is the single source of truth for
 * what it needs; the shell grants exactly that instead of duplicating a list per
 * route. Domains a napplet treats as optional still appear here — optionality is
 * a runtime guard (`if (window.napplet?.count)`) inside the napplet, not an
 * absence from the manifest.
 *
 * `DOMParser` does not execute scripts, so parsing the artifact is inert.
 */
function readNappletDomains(html: string): string[] {
  const content = new DOMParser()
    .parseFromString(html, 'text/html')
    .querySelector('meta[name="napplet-requires"]')
    ?.getAttribute('content');

  if (!content) return [];

  return content
    .split(',')
    .map((domain) => domain.trim())
    .filter(Boolean);
}

/** Collapses the mobile drawer. Navigating with it still open would hide the new page. */
function closeDrawer() {
  const drawerToggle = document.getElementById('stlstr-drawer');
  if (drawerToggle instanceof HTMLInputElement) drawerToggle.checked = false;
}

function accountLabel(account: StlstrAccount) {
  return account.metadata?.name || 'Saved account';
}

function accountMethodLabel(account: StlstrAccount) {
  switch (account.metadata?.loginMethod) {
    case 'extension':
      return 'Browser extension';
    case 'bunker':
    case 'nostrconnect':
      return 'Remote signer';
    default:
      return 'Nostr account';
  }
}

function AccountIdentity({
  account,
  active,
  compact = false,
}: {
  account: StlstrAccount;
  active?: boolean;
  compact?: boolean;
}) {
  const user = getUser(account.pubkey);
  const profile = use$(() => user.profile$, [user.pubkey]);
  const label = getDisplayName(profile, accountLabel(account));
  const picture = getProfilePicture(profile);

  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="avatar placeholder shrink-0">
        <div className="h-10 w-10 rounded-full bg-primary text-primary-content">
          {picture ? <img src={picture} alt="" /> : <span>{label.slice(0, 1).toUpperCase()}</span>}
        </div>
      </div>
      <div className="min-w-0 text-left">
        <div className="flex items-center gap-2">
          <span className="truncate font-semibold">{label}</span>
          {active && <span className="badge badge-primary badge-sm">active</span>}
        </div>
        {!compact && (
          <div className="text-sm text-base-content/60">{accountMethodLabel(account)}</div>
        )}
      </div>
    </div>
  );
}

function switchAccount(account: StlstrAccount) {
  accountManager.setActive(account);
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

function LoginDialog({ dialogRef }: { dialogRef: RefObject<HTMLDialogElement | null> }) {
  const accounts = use$(accountManager.accounts$) ?? [];
  const active = use$(accountManager.active$);
  const [mode, setMode] = useState<'choose' | 'bunker' | 'qr'>('choose');
  const [bunkerUri, setBunkerUri] = useState('');
  const [qrUri, setQrUri] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const qrSignerRef = useRef<NostrConnectSigner | null>(null);
  const qrAbortRef = useRef<AbortController | null>(null);

  function closeDialog() {
    qrAbortRef.current?.abort();
    qrAbortRef.current = null;
    void qrSignerRef.current?.close();
    qrSignerRef.current = null;
    setBusy(false);
    setError('');
    setMode('choose');
    setQrUri('');
    setQrDataUrl('');
    dialogRef.current?.close();
  }

  function selectExistingAccount(account: StlstrAccount) {
    switchAccount(account);
    closeDialog();
  }

  function returnToChooseMode() {
    qrAbortRef.current?.abort();
    qrAbortRef.current = null;
    void qrSignerRef.current?.close();
    qrSignerRef.current = null;
    setBusy(false);
    setError('');
    setQrUri('');
    setQrDataUrl('');
    setMode('choose');
  }

  async function handleExtensionLogin() {
    if (!window.nostr) {
      setError(
        'No NIP-07 browser extension was found. Install or unlock your extension and try again.',
      );
      return;
    }

    try {
      setBusy(true);
      setError('');
      await loginWithExtension();
      closeDialog();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Extension login failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleBunkerSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!bunkerUri.trim()) return;

    try {
      setBusy(true);
      setError('');
      await loginWithBunkerUri(bunkerUri.trim());
      closeDialog();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Remote signer login failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleQrLogin() {
    let timeout: number | undefined;

    try {
      qrAbortRef.current?.abort();
      qrAbortRef.current = null;
      void qrSignerRef.current?.close();
      qrSignerRef.current = null;
      setBusy(true);
      setError('');
      setQrUri('');
      setQrDataUrl('');
      const { signer, uri } = createNostrConnectLogin();
      const abort = new AbortController();
      timeout = window.setTimeout(() => abort.abort(), 120_000);

      qrSignerRef.current = signer;
      qrAbortRef.current = abort;
      setQrUri(uri);
      setQrDataUrl(await toDataURL(uri, { margin: 2, width: 240 }));

      await signer.waitForSigner(abort.signal);
      window.clearTimeout(timeout);
      await finishNostrConnectLogin(signer);
      qrSignerRef.current = null;
      qrAbortRef.current = null;
      closeDialog();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'QR login failed or timed out.');
      void qrSignerRef.current?.close();
      qrSignerRef.current = null;
      qrAbortRef.current = null;
    } finally {
      if (timeout) window.clearTimeout(timeout);
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialogRef} className="modal">
      <div className="modal-box max-w-lg">
        <button
          className="btn btn-circle btn-ghost btn-sm absolute right-2 top-2"
          onClick={closeDialog}
        >
          x
        </button>

        <h2 className="text-2xl font-bold">Login to STLstr</h2>
        <p className="mt-2 text-sm text-base-content/65">
          Use a browser extension or remote signer. Accounts are saved locally in the shell.
        </p>

        {mode === 'choose' && (
          <div className="mt-6 grid gap-3">
            {accounts.length > 0 && (
              <div className="grid gap-2">
                <div className="text-sm font-semibold text-base-content/70">Saved accounts</div>
                {accounts.map((account) => (
                  <button
                    key={account.id}
                    className="btn h-auto justify-start rounded-box border border-base-300 bg-base-100 p-3 text-left hover:border-primary"
                    onClick={() => selectExistingAccount(account)}
                  >
                    <AccountIdentity account={account} active={active?.id === account.id} />
                  </button>
                ))}
                <div className="divider my-1 text-xs text-base-content/50">Add another account</div>
              </div>
            )}
            <button
              className="btn btn-primary justify-start"
              disabled={busy}
              onClick={handleExtensionLogin}
            >
              Browser extension
            </button>
            <button
              className="btn btn-outline justify-start"
              disabled={busy}
              onClick={() => setMode('bunker')}
            >
              Remote signer with bunker URI
            </button>
            <button
              className="btn btn-outline justify-start"
              disabled={busy}
              onClick={() => {
                setMode('qr');
                void handleQrLogin();
              }}
            >
              Remote signer with QR code
            </button>
          </div>
        )}

        {mode === 'bunker' && (
          <form className="mt-6 grid gap-4" onSubmit={handleBunkerSubmit}>
            <label className="fieldset">
              <span className="fieldset-legend mb-2">Bunker URI</span>
              <input
                className="input font-mono text-sm w-full"
                placeholder="bunker://..."
                value={bunkerUri}
                onChange={(event) => setBunkerUri(event.target.value)}
              />
            </label>
            <div className="flex justify-between gap-2">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={returnToChooseMode}
              >
                Back
              </button>
              <button className="btn btn-primary" disabled={busy || !bunkerUri.trim()}>
                {busy ? 'Connecting...' : 'Connect'}
              </button>
            </div>
          </form>
        )}

        {mode === 'qr' && (
          <div className="mt-6 grid gap-4">
            <div className="alert alert-info text-sm">
              <span>
                Uses the default remote signer relay for setup. Relay editing can come later.
              </span>
            </div>
            {qrDataUrl ? (
              <div className="flex flex-col items-center gap-3 text-center">
                <a
                  href={qrUri}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-box bg-white p-4"
                >
                  <img src={qrDataUrl} alt="Nostr Connect QR code" className="h-60 w-60" />
                </a>
                <a
                  className="link link-primary break-all text-xs"
                  href={qrUri}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open remote signer link
                </a>
                <span className="loading loading-spinner loading-md" />
                <p className="text-sm text-base-content/65">Waiting for your remote signer...</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 rounded-box border border-base-300 bg-base-100 p-6 text-center">
                {busy ? (
                  <>
                    <span className="loading loading-spinner loading-lg" />
                    <p className="text-sm text-base-content/65">
                      Preparing your remote signer QR code...
                    </p>
                  </>
                ) : (
                  <button className="btn btn-primary" onClick={handleQrLogin}>
                    Try again
                  </button>
                )}
              </div>
            )}
            <div className="flex justify-between gap-2">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy && !qrDataUrl}
                onClick={returnToChooseMode}
              >
                Back
              </button>
              {qrDataUrl && (
                <button type="button" className="btn btn-outline" onClick={closeDialog}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="alert alert-error mt-5 text-sm">
            <span>{error}</span>
          </div>
        )}
      </div>
      <form method="dialog" className="modal-backdrop">
        <button onClick={closeDialog}>close</button>
      </form>
    </dialog>
  );
}

function AccountsDialog({ dialogRef }: { dialogRef: RefObject<HTMLDialogElement | null> }) {
  const accounts = use$(accountManager.accounts$) ?? [];
  const active = use$(accountManager.active$);

  async function removeAccount(account: StlstrAccount) {
    if (account instanceof NostrConnectAccount) await account.signer.close();
    accountManager.removeAccount(account);
  }

  return (
    <dialog ref={dialogRef} className="modal">
      <div className="modal-box max-w-2xl">
        <form method="dialog">
          <button className="btn btn-circle btn-ghost btn-sm absolute right-2 top-2">x</button>
        </form>
        <h2 className="text-2xl font-bold">Accounts</h2>
        <p className="mt-2 text-sm text-base-content/65">
          Switch or remove locally saved accounts.
        </p>

        <div className="mt-6 grid gap-3">
          {accounts.length === 0 && (
            <div className="text-sm text-base-content/65">No accounts saved yet.</div>
          )}
          {accounts.map((account) => (
            <div key={account.id} className="card bg-base-100 shadow-sm">
              <div className="card-body p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <AccountIdentity account={account} active={active?.id === account.id} />
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={active?.id === account.id}
                      onClick={() => switchAccount(account)}
                    >
                      Use
                    </button>
                    <button
                      className="btn btn-error btn-outline btn-sm"
                      onClick={() => void removeAccount(account)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button>close</button>
      </form>
    </dialog>
  );
}

function AccountNav() {
  const active = use$(accountManager.active$);
  const accounts = use$(accountManager.accounts$) ?? [];
  const loginDialogRef = useRef<HTMLDialogElement | null>(null);
  const accountsDialogRef = useRef<HTMLDialogElement | null>(null);

  return (
    <div className="flex items-center gap-2">
      {active ? (
        <div className="dropdown dropdown-end">
          <button tabIndex={0} className="btn btn-outline btn-sm">
            <AccountIdentity account={active} compact />
          </button>
          <ul
            tabIndex={0}
            className="menu dropdown-content z-10 mt-3 w-72 rounded-box bg-base-100 p-2 shadow-xl"
          >
            {accounts.map((account) => (
              <li key={account.id}>
                <button
                  className="h-auto py-3"
                  disabled={active.id === account.id}
                  onClick={() => switchAccount(account)}
                >
                  <AccountIdentity account={account} active={active.id === account.id} />
                </button>
              </li>
            ))}
            <li className="my-1 h-px bg-base-300" />
            <li>
              <button onClick={() => accountsDialogRef.current?.showModal()}>
                Manage accounts
              </button>
            </li>
            <li>
              <button onClick={() => loginDialogRef.current?.showModal()}>Add account</button>
            </li>
            <li>
              <Link
                to="/settings"
                onClick={() => {
                  // Blur so the DaisyUI dropdown closes; it stays open while focused.
                  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
                }}
              >
                Settings
              </Link>
            </li>
            <li>
              <button onClick={() => accountManager.clearActive()}>Disconnect</button>
            </li>
          </ul>
        </div>
      ) : (
        <button
          className="btn btn-primary btn-sm"
          onClick={() => loginDialogRef.current?.showModal()}
        >
          Login
        </button>
      )}
      <LoginDialog dialogRef={loginDialogRef} />
      <AccountsDialog dialogRef={accountsDialogRef} />
    </div>
  );
}

/**
 * Mounts one napplet in a sandboxed iframe and gives it a shell bridge.
 *
 * `routeId` names the shell route mounting the napplet; it distinguishes windows
 * when several routes share one napplet (browse/search/tag all mount
 * `browse`). The iframe is keyed by pathname, so navigating between two
 * objects tears the napplet down and rebuilds it against the new address.
 */
function NappletFrame({
  napplet,
  routeId,
  title,
  intent,
  frameKey,
}: {
  napplet: string;
  routeId: string;
  title: string;
  /**
   * The intent this route materializes. Delivered to the napplet once it signals
   * readiness — see `services/intent-delivery.ts` for why this cannot ride NAP-INTENT.
   */
  intent?: StlstrIntent;
  /**
   * Identity of this frame. Changing it tears the napplet down and rebuilds it; a payload
   * change alone does not (that redelivers in place). Defaults to the pathname, which is
   * what distinguishes one routed napplet from the next. The preview dialog passes a
   * constant so a base-route change underneath it cannot destroy an open preview.
   */
  frameKey?: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef<ShellBridge | null>(null);
  const [status, setStatus] = useState('Loading napplet...');
  const { pathname } = useLocation();
  const navigate = useShellNavigate();
  const identity = frameKey ?? pathname;

  // Serializing keeps the effect dep stable across the fresh object each render builds.
  const intentKey = intent ? JSON.stringify(intent) : '';

  // The payload is NOT a mount dep: a new payload for the same frame is redelivered to the
  // live napplet rather than remounting it, so an open 3D preview keeps its WebGL context
  // when the user picks another part. The mount path reads the latest value through the ref.
  //
  // Synced in an effect rather than assigned during render: writing a ref while rendering
  // is what `react-hooks/refs` forbids. `useRef(intent)` already seeds the first render,
  // and effects run in declaration order, so this lands before the mount effect below
  // reads it — the same idiom `navigateRef` uses.
  const intentRef = useRef(intent);
  useEffect(() => {
    intentRef.current = intent;
  }, [intent]);
  const deliveryRef = useRef<IntentDelivery | null>(null);
  const deliveredKeyRef = useRef('');

  // NAP-INTENT navigates the shell, but a new `navigate` identity must never tear
  // down a live bridge — so the adapter reads it through a ref instead of a dep.
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  useEffect(() => {
    let cancelled = false;
    // The adapter needs the bridge's session registry, and the bridge needs the adapter,
    // so identity is resolved lazily through this binding rather than at construction.
    let bridge: ShellBridge | null = null;
    const adapter = createStlstrAdapter({
      navigate: (href) => navigateRef.current(href),
      resolveIdentity: (windowId) => {
        const entry = bridge?.runtime.sessionRegistry
          .getAllEntries()
          .find((session) => session.windowId === windowId);
        return entry ? { dTag: entry.dTag, aggregateHash: entry.aggregateHash } : null;
      },
    });

    const shell = createShellBridge(adapter);
    bridge = shell;
    bridgeRef.current = shell;
    const windowId = `route-${routeId}-${napplet}`;
    const aggregateHash = `dev-${napplet}-build`;

    const delivery = createIntentDelivery({
      getTarget: () => iframeRef.current?.contentWindow ?? null,
    });
    deliveryRef.current = delivery;

    // Observing the readiness signal is NON-consuming: the message still reaches the
    // bridge so ordinary inc subscribers see it.
    //
    // The source check is load-bearing once more than one frame is mounted — the preview
    // dialog puts a second napplet on this same `window`. Every frame installs its own
    // listener and its own bridge, while `originRegistry` is a module-level singleton, so
    // without this guard frame A's messages reach frame B's bridge, resolve to a windowId
    // absent from B's session registry, and are either dropped as unrouted or serviced twice.
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      delivery.observeReady(event);
      shell.handleMessage(event);
    };
    window.addEventListener('message', handleMessage);

    async function loadNapplet() {
      const iframe = iframeRef.current;
      if (!iframe?.contentWindow) return;

      const fallbackUrl = `/napplets.dev/${napplet}/index.html`;
      const url = await resolveNappletUrl(napplet, fallbackUrl);
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Build ${napplet} first: ${response.status} ${response.statusText}`);
      }

      const html = await response.text();
      if (cancelled) return;

      const domains = readNappletDomains(html);
      if (domains.length === 0) {
        console.warn(
          `[stlstr] ${napplet} declares no NAP domains; add them to its vite.config nip5aManifest({ requires }).`,
        );
      }

      originRegistry.register(iframe.contentWindow, windowId, { dTag: napplet, aggregateHash });
      shell.runtime.sessionRegistry.register(windowId, {
        pubkey: '',
        windowId,
        origin: window.location.origin,
        type: napplet,
        dTag: napplet,
        aggregateHash,
        registeredAt: Date.now(),
        instanceId: windowId,
        provenance: 'nip-5d',
      });

      // Buffer the payload BEFORE the napplet can boot and signal readiness. Read through
      // the ref, so a payload that changed while this async load was in flight is the one
      // that gets seeded — the redelivery effect below stands down until this point.
      const seeded = intentRef.current;
      if (seeded) {
        delivery.seed(seeded);
        deliveredKeyRef.current = JSON.stringify(seeded);
      }

      // Sealed last so the guard sits ahead of the NAP prelude and the napplet's own code.
      iframe.srcdoc = sealNappletFrame(injectNappletNamespacePrelude(html, { domains }));
      setStatus(`Loaded ${napplet}`);
    }

    loadNapplet().catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : `Failed to load ${napplet}.`);
    });

    return () => {
      cancelled = true;
      window.removeEventListener('message', handleMessage);
      originRegistry.unregister(windowId);
      shell.runtime.sessionRegistry.unregister(windowId);
      shell.destroy();
      delivery.dispose();
      deliveryRef.current = null;
      deliveredKeyRef.current = '';
      bridge = null;
      bridgeRef.current = null;
    };
  }, [napplet, routeId, identity]);

  // NAP-IDENTITY is request/response, so a napplet that asked "who is signed in?" at mount
  // would hold a stale answer forever. Pushing on every account change is what lets an
  // owner-gated action (object-detail's "Edit this object") appear the moment the owner
  // signs in, instead of after a reload.
  //
  // `publishIdentityChanged`, NOT `injectEvent`: the former posts the `identity.changed`
  // envelope the SDK's `identity.onChanged` listens for, while the latter would deliver an
  // inc.event on a topic nothing is subscribed to.
  useEffect(() => {
    const subscription = accountManager.active$.subscribe((account) => {
      bridgeRef.current?.publishIdentityChanged(account?.pubkey ?? '');
    });
    return () => subscription.unsubscribe();
  }, []);

  // A payload change on a frame that is already up. `deliveredKeyRef` is the interlock
  // against the mount seed: whichever of the two runs first records the key, and the other
  // stands down rather than delivering the same payload twice.
  useEffect(() => {
    if (!intent || !intentKey) return;
    if (deliveredKeyRef.current === intentKey) return;

    // Still loading — `loadNapplet` seeds from the ref, which already holds this payload.
    const delivery = deliveryRef.current;
    if (!delivery || !deliveredKeyRef.current) return;

    deliveredKeyRef.current = intentKey;
    delivery.redeliver(intent);
  }, [intent, intentKey]);

  return (
    <section className="flex h-full flex-col bg-base-100">
      <iframe
        key={identity}
        ref={iframeRef}
        title={`${title} napplet`}
        sandbox="allow-scripts"
        className="h-full w-full flex-1 border-0 bg-base-100"
      />
      <span className="sr-only" aria-live="polite">
        {status}
      </span>
    </section>
  );
}

/**
 * The centered dialog that hosts an overlay napplet over the current page.
 *
 * The open preview lives in the URL (`?preview=<fileId>`), not in React state, so a
 * preview is deep-linkable and Back closes it. That makes the URL the single source of
 * truth, and dismissal must therefore go through history — calling `dialog.close()` alone
 * would leave a closed dialog with `?preview=` still in the address bar, which Back would
 * then re-open.
 */
function PreviewDialog() {
  const location = useLocation();
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const overlay = overlayFromLocation(location);
  const open = Boolean(overlay);

  const dismiss = useCallback(() => {
    // A preview we pushed has a page beneath it in history, so Back is the dismissal that
    // keeps the stack honest. A deep-linked preview has nothing behind it — going back
    // would leave the app entirely — so it collapses to the base page instead.
    const pushed = (location.state as { previewPushed?: boolean } | null)?.previewPushed;
    if (pushed) void navigate(-1);
    else void navigate(baseHref(`${location.pathname}${location.search}`), { replace: true });
  }, [navigate, location.pathname, location.search, location.state]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      // The click came from inside an iframe, so the browser cannot restore focus for us.
      restoreFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // `showModal` rather than the `modal-open` class alone: it is what makes the page
      // behind inert and gives the focus trap and ESC handling.
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
      restoreFocusRef.current?.focus();
      restoreFocusRef.current = null;
    }
  }, [open]);

  if (!overlay) return null;

  return (
    <dialog
      ref={dialogRef}
      className="modal modal-bottom sm:modal-middle"
      aria-label="Part preview"
      onCancel={(event) => {
        // ESC would close the dialog without touching the URL. Route it through dismiss.
        event.preventDefault();
        dismiss();
      }}
    >
      <div className="modal-box flex h-[85vh] max-h-[85vh] w-full max-w-5xl flex-col overflow-hidden p-0">
        <div className="flex items-center justify-between border-b border-base-300 px-4 py-2">
          <h2 className="font-semibold">Part preview</h2>
          <button
            className="btn btn-circle btn-ghost btn-sm"
            aria-label="Close preview"
            data-testid="preview-close"
            onClick={dismiss}
          >
            x
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <NappletFrame
            napplet="part-preview"
            routeId="overlay-preview"
            title="Part preview"
            intent={overlay}
            // Constant: the dialog outlives base-route changes underneath it, and a new
            // file is redelivered to the live napplet rather than rebuilding the viewer.
            frameKey="overlay-preview"
          />
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button
          type="button"
          onClick={dismiss}
          aria-label="Close preview"
          data-testid="preview-backdrop"
        >
          close
        </button>
      </form>
    </dialog>
  );
}

/** Navigates, collapsing the mobile drawer first so the new page is visible. */
function useShellNavigate() {
  const navigate = useNavigate();
  const location = useLocation();

  return useCallback(
    (href: string) => {
      closeDrawer();

      // A navigation that opens a preview marks its history entry, so the dialog knows it
      // has a page to go Back to. Derived from the two URLs rather than passed in, so any
      // route into a preview — an intent, a Link, a share — is marked the same way.
      const opensPreview = hasPreview(href) && !hasPreview(location.search);
      void navigate(href, opensPreview ? { state: { previewPushed: true } } : undefined);
    },
    [navigate, location.search],
  );
}

function BrowseRoute() {
  return (
    <NappletFrame
      napplet="browse"
      routeId="browse"
      title="Browse objects"
      intent={{ archetype: 'browse', action: 'open', payload: {} }}
    />
  );
}

function SearchRoute() {
  const [searchParams] = useSearchParams();
  const query = searchParams.get('q')?.trim() ?? '';

  return (
    <NappletFrame
      napplet="browse"
      routeId="search"
      title={query ? `Search: ${query}` : 'Search objects'}
      intent={{ archetype: 'browse', action: 'open', payload: query ? { query } : {} }}
    />
  );
}

function TagRoute() {
  const { tag = '' } = useParams();

  return (
    <NappletFrame
      napplet="browse"
      routeId="tag"
      title={`#${tag}`}
      intent={{ archetype: 'browse', action: 'open', payload: { tag } }}
    />
  );
}

function CreateRoute() {
  const [searchParams] = useSearchParams();
  const remixOf = searchParams.get('remix')?.trim() ?? '';

  return (
    <NappletFrame
      napplet="create-object"
      routeId="create"
      title="Create object"
      intent={{ archetype: 'create-object', action: 'open', payload: remixOf ? { remixOf } : {} }}
    />
  );
}

/** The maker behind an object: profile metadata, their objects, their collections. */
function UserProfileRoute() {
  const { pubkey = '' } = useParams();

  return (
    <NappletFrame
      napplet="user-profile"
      routeId="user-profile"
      title="Maker profile"
      intent={{ archetype: 'user-profile', action: 'open', payload: { pubkey } }}
    />
  );
}

function ObjectDetailRoute() {
  const { pubkey = '', identifier = '' } = useParams();

  return (
    <NappletFrame
      napplet="object-detail"
      routeId="object-detail"
      title="Object details"
      intent={{
        archetype: 'object-detail',
        action: 'open',
        payload: { address: `33500:${pubkey}:${identifier}` },
      }}
    />
  );
}

function ObjectEditRoute() {
  const { pubkey = '', identifier = '' } = useParams();

  return (
    <NappletFrame
      napplet="edit-object"
      routeId="object-edit"
      title="Edit object"
      intent={{
        archetype: 'edit-object',
        action: 'edit',
        payload: { address: `33500:${pubkey}:${identifier}` },
      }}
    />
  );
}

function NotFoundRoute() {
  return (
    <section className="grid min-h-screen content-start gap-3 bg-base-100 p-4">
      <div className="alert alert-warning">
        <span>This STLstr route does not exist yet.</span>
      </div>
      <Link className="btn btn-primary w-fit" to="/">
        Browse objects
      </Link>
    </section>
  );
}

/**
 * A top-level nav entry. `alsoActiveOn` keeps a section highlighted on its
 * sub-routes — Browse stays lit on /search and /tags/*, which are the same
 * napplet under different framing.
 */
function ShellNavLink({
  to,
  label,
  alsoActiveOn,
}: {
  to: string;
  label: string;
  alsoActiveOn?: RegExp;
}) {
  const { pathname } = useLocation();
  const activeOnSubRoute = alsoActiveOn?.test(pathname) ?? false;

  return (
    <li>
      <NavLink
        to={to}
        end
        onClick={closeDrawer}
        className={({ isActive }) => (isActive || activeOnSubRoute ? 'active' : undefined)}
      >
        {label}
      </NavLink>
    </li>
  );
}

function BrandLogo({ className = 'size-8' }: { className?: string }) {
  return <img src="/logo.svg" alt="" className={className} aria-hidden="true" />;
}

function ShellLayout() {
  const [accountsReady, setAccountsReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    accountManagerReady.finally(() => {
      if (!cancelled) setAccountsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const navLinks = (
    <>
      <ShellNavLink to="/" label="Browse" alsoActiveOn={/^\/(search|tags)(\/|$)/} />
      <ShellNavLink to="/create" label="Create" />
      <ShellNavLink to="/settings" label="Settings" />
    </>
  );

  return (
    <div className="drawer h-dvh overflow-hidden bg-base-200">
      <input id="stlstr-drawer" type="checkbox" className="drawer-toggle" />
      <div className="drawer-content flex h-dvh flex-col">
        <header className="navbar bg-base-100 shadow-sm">
          <div className="flex-none lg:hidden">
            <label
              htmlFor="stlstr-drawer"
              className="btn btn-square btn-ghost"
              aria-label="Open navigation"
            >
              <span className="text-xl">=</span>
            </label>
          </div>
          <div className="flex-1">
            <Link className="btn btn-ghost gap-2 text-xl" to="/" onClick={closeDrawer}>
              <BrandLogo />
              STLstr
            </Link>
          </div>
          <nav className="hidden flex-none lg:block">
            <ul className="menu menu-horizontal gap-1 px-1">{navLinks}</ul>
          </nav>
          <div className="flex-none">
            {accountsReady ? (
              <AccountNav />
            ) : (
              <span className="loading loading-spinner loading-sm" />
            )}
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-auto bg-base-100">
          <Outlet />
        </main>

        {/* Outside the Outlet: the overlay is layered over whatever route is beneath it,
            and must survive that route being swapped. */}
        <PreviewDialog />
      </div>

      <aside className="drawer-side lg:hidden">
        <label
          htmlFor="stlstr-drawer"
          aria-label="Close navigation"
          className="drawer-overlay"
        ></label>
        <div className="min-h-full w-72 bg-base-100 p-4">
          <div className="mb-1 flex items-center gap-2 text-2xl font-bold">
            <BrandLogo className="size-9" />
            STLstr
          </div>
          <p className="mb-4 text-xs text-base-content/60">
            The worst named nostr app for 3d printing
          </p>
          <ul className="menu gap-1">{navLinks}</ul>
        </div>
      </aside>
    </div>
  );
}

/**
 * The shell route table. Every route renders inside `ShellLayout`, so the navbar
 * and drawer persist across navigations. Settings is the one route the shell
 * renders itself; everything else mounts a napplet.
 *
 * Route ranking is by specificity, not declaration order, so `objects/:pubkey/
 * :identifier/edit` wins over `objects/:pubkey/:identifier` on its own.
 */
function App() {
  return (
    <Routes>
      <Route element={<ShellLayout />}>
        <Route index element={<BrowseRoute />} />
        <Route path="search" element={<SearchRoute />} />
        <Route path="tags/:tag" element={<TagRoute />} />
        <Route path="create" element={<CreateRoute />} />
        <Route path="settings" element={<SettingsView />} />
        <Route path="profiles/:pubkey" element={<UserProfileRoute />} />
        <Route path="objects/:pubkey/:identifier" element={<ObjectDetailRoute />} />
        <Route path="objects/:pubkey/:identifier/edit" element={<ObjectEditRoute />} />
        <Route path="*" element={<NotFoundRoute />} />
      </Route>
    </Routes>
  );
}

export default App;
