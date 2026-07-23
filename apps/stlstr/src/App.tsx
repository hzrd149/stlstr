import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
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
import { toDataURL } from 'qrcode';
import {
  accountManager,
  accountManagerReady,
  createNostrConnectLogin,
  finishNostrConnectLogin,
  loginWithBunkerUri,
  loginWithExtension,
  type StlstrAccount,
} from './services/accounts';
import { getUser } from './services/nostr';

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

type AppRoute = {
  id: string;
  path: string;
  title: string;
  description: string;
  nav?: 'browse' | 'create';
  nappletName?: string;
  domains?: string[];
  params?: Record<string, string>;
};

const DEFAULT_ROUTE: AppRoute = {
  id: 'browse',
  path: '/',
  title: 'Browse objects',
  description: 'Find printable objects published as Nostr events.',
  nav: 'browse',
  nappletName: 'browse-objects',
  domains: ['outbox', 'identity', 'common', 'count', 'resource', 'intent'],
};

const CREATE_ROUTE: AppRoute = {
  id: 'create',
  path: '/create',
  title: 'Create object',
  description: 'Publish a new 3D printable object with images and files.',
  nav: 'create',
  nappletName: 'create-object',
  domains: ['storage', 'identity', 'upload', 'outbox', 'intent'],
};

function createNoopAdapter(): ShellAdapter {
  return {
    relayPool: {
      getRelayPool: () => null,
      trackSubscription: () => {},
      untrackSubscription: () => {},
      openScopedRelay: () => {},
      closeScopedRelay: () => {},
      publishToScopedRelay: () => false,
      selectRelayTier: () => [],
    },
    relayConfig: {
      addRelay: () => {},
      removeRelay: () => {},
      getRelayConfig: () => ({ discovery: [], super: [], outbox: [] }),
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
      getNappUpdateBehavior: () => 'banner',
    },
    hotkeys: {
      executeHotkeyFromForward: () => {},
    },
    workerRelay: {
      getWorkerRelay: () => null,
    },
    crypto: {
      verifyEvent: async () => false,
    },
    capabilities: {
      disabledDomains: ['relay'],
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

function normalizePath(pathname: string) {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname || '/';
}

function decodePart(value: string | undefined) {
  return value ? decodeURIComponent(value) : '';
}

function routeFromLocation(location: Location): AppRoute {
  const path = normalizePath(location.pathname);
  const parts = path.split('/').filter(Boolean);

  if (path === '/') return DEFAULT_ROUTE;
  if (path === '/create') return CREATE_ROUTE;
  if (path === '/search') {
    const query = new URLSearchParams(location.search).get('q')?.trim() ?? '';
    return {
      ...DEFAULT_ROUTE,
      id: 'search',
      path: `${path}${location.search}`,
      title: query ? `Search: ${query}` : 'Search objects',
      description: 'Search printable objects by name, tag, maker, or file type.',
      params: { query },
    };
  }
  if (parts[0] === 'tags' && parts[1]) {
    const tag = decodePart(parts[1]);
    return {
      ...DEFAULT_ROUTE,
      id: 'tag',
      path,
      title: `#${tag}`,
      description: 'Browse printable objects with this tag.',
      params: { tag },
    };
  }
  if (parts[0] === 'objects' && parts[1] && parts[2] && parts[3] === 'edit') {
    const pubkey = decodePart(parts[1]);
    const identifier = decodePart(parts[2]);
    return {
      id: 'object-edit',
      path,
      title: 'Edit object',
      description: 'Load an owned printable object and publish a replacement event.',
      nappletName: 'edit-object',
      domains: ['outbox', 'upload', 'identity', 'storage', 'resource', 'intent'],
      params: { pubkey, identifier, address: `33500:${pubkey}:${identifier}` },
    };
  }
  if (parts[0] === 'objects' && parts[1] && parts[2]) {
    const pubkey = decodePart(parts[1]);
    const identifier = decodePart(parts[2]);
    return {
      id: 'object-detail',
      path,
      title: 'Object details',
      description: 'View images, files, metadata, maker attribution, and object actions.',
      nappletName: 'object-detail',
      domains: ['outbox', 'identity', 'common', 'count', 'resource', 'intent', 'link'],
      params: { pubkey, identifier, address: `33500:${pubkey}:${identifier}` },
    };
  }

  return {
    id: 'not-found',
    path,
    title: 'Page not found',
    description: 'This stlstr route does not exist yet.',
  };
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

        <h2 className="text-2xl font-bold">Login to stlstr</h2>
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
            <label className="form-control">
              <span className="label-text mb-2">Bunker URI</span>
              <input
                className="input input-bordered font-mono text-sm"
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

function NappletFrame({ route }: { route: AppRoute }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef<ShellBridge | null>(null);
  const [status, setStatus] = useState('Loading napplet...');

  useEffect(() => {
    if (!route.nappletName) return;

    let cancelled = false;
    const bridge = createShellBridge(createNoopAdapter());
    bridgeRef.current = bridge;
    const windowId = `route-${route.id}-${route.nappletName}`;
    const aggregateHash = `dev-${route.nappletName}-build`;

    const handleMessage = (event: MessageEvent) => bridge.handleMessage(event);
    window.addEventListener('message', handleMessage);

    async function loadNapplet() {
      const iframe = iframeRef.current;
      if (!iframe?.contentWindow || !route.nappletName) return;

      const fallbackUrl = `/napplets.dev/${route.nappletName}/index.html`;
      const url = await resolveNappletUrl(route.nappletName, fallbackUrl);
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(
          `Build ${route.nappletName} first: ${response.status} ${response.statusText}`,
        );
      }

      const html = await response.text();
      if (cancelled) return;

      originRegistry.register(iframe.contentWindow, windowId, {
        dTag: route.nappletName,
        aggregateHash,
      });
      bridge.runtime.sessionRegistry.register(windowId, {
        pubkey: '',
        windowId,
        origin: window.location.origin,
        type: route.nappletName,
        dTag: route.nappletName,
        aggregateHash,
        registeredAt: Date.now(),
        instanceId: windowId,
        provenance: 'nip-5d',
      });

      iframe.srcdoc = injectNappletNamespacePrelude(html, {
        domains: route.domains ?? [],
      });
      setStatus(`Loaded ${route.nappletName}`);
    }

    loadNapplet().catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : `Failed to load ${route.nappletName}.`);
    });

    return () => {
      cancelled = true;
      window.removeEventListener('message', handleMessage);
      originRegistry.unregister(windowId);
      bridge.runtime.sessionRegistry.unregister(windowId);
      bridge.destroy();
      bridgeRef.current = null;
    };
  }, [route]);

  if (!route.nappletName) {
    return (
      <section className="grid min-h-screen content-start gap-3 bg-base-100">
        <div className="alert alert-warning">
          <span>{route.description}</span>
        </div>
        <a className="btn btn-primary w-fit" href="/">
          Browse objects
        </a>
      </section>
    );
  }

  return (
    <section className="bg-base-100">
      <iframe
        key={route.path}
        ref={iframeRef}
        title={`${route.title} napplet`}
        sandbox="allow-scripts"
        className="min-h-screen w-full border-0 bg-base-100"
      />
      <span className="sr-only" aria-live="polite">
        {status}
      </span>
    </section>
  );
}

function NavLink({
  active,
  href,
  label,
  navigate,
}: {
  active: boolean;
  href: string;
  label: string;
  navigate: (href: string) => void;
}) {
  return (
    <li>
      <a
        className={active ? 'active' : undefined}
        href={href}
        onClick={(event) => {
          event.preventDefault();
          navigate(href);
        }}
      >
        {label}
      </a>
    </li>
  );
}

function App() {
  const [accountsReady, setAccountsReady] = useState(false);
  const [route, setRoute] = useState(() => routeFromLocation(window.location));

  useEffect(() => {
    let cancelled = false;
    accountManagerReady.finally(() => {
      if (!cancelled) setAccountsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onPopState = () => setRoute(routeFromLocation(window.location));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  function navigate(href: string) {
    if (href === `${window.location.pathname}${window.location.search}`) return;
    window.history.pushState(null, '', href);
    setRoute(routeFromLocation(window.location));
  }

  const nav = (
    <ul className="menu menu-horizontal gap-1 px-1">
      <NavLink active={route.nav === 'browse'} href="/" label="Browse" navigate={navigate} />
      <NavLink active={route.nav === 'create'} href="/create" label="Create" navigate={navigate} />
    </ul>
  );

  return (
    <div className="drawer min-h-screen bg-base-200 lg:drawer-open">
      <input id="stlstr-drawer" type="checkbox" className="drawer-toggle" />
      <div className="drawer-content flex min-h-screen flex-col">
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
            <a
              className="btn btn-ghost text-xl"
              href="/"
              onClick={(event) => {
                event.preventDefault();
                navigate('/');
              }}
            >
              stlstr
            </a>
          </div>
          <nav className="hidden flex-none lg:block">{nav}</nav>
          <div className="flex-none">
            {accountsReady ? (
              <AccountNav />
            ) : (
              <span className="loading loading-spinner loading-sm" />
            )}
          </div>
        </header>

        <main className="flex-1 bg-base-100">
          <NappletFrame route={route} />
        </main>
      </div>

      <aside className="drawer-side">
        <label
          htmlFor="stlstr-drawer"
          aria-label="Close navigation"
          className="drawer-overlay"
        ></label>
        <div className="min-h-full w-72 bg-base-100 p-4">
          <div className="mb-4 text-2xl font-bold">stlstr</div>
          <ul className="menu gap-1">
            <NavLink active={route.nav === 'browse'} href="/" label="Browse" navigate={navigate} />
            <NavLink
              active={route.nav === 'create'}
              href="/create"
              label="Create"
              navigate={navigate}
            />
          </ul>
          <div className="divider"></div>
          <div className="alert alert-warning text-sm">
            <span>Blossom and outbox service adapters are still pending.</span>
          </div>
        </div>
      </aside>
    </div>
  );
}

export default App;
