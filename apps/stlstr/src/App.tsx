import { useEffect, useRef, useState } from 'react';
import {
  createShellBridge,
  injectNappletNamespacePrelude,
  originRegistry,
  type ShellAdapter,
  type ShellBridge,
} from '@kehto/shell';

const COUNTER_NAPPLET_NAME = 'counter';
const COUNTER_WINDOW_ID = 'default-counter';
const COUNTER_AGGREGATE_HASH = 'dev-counter-build';
const COUNTER_URL = `/napplets.dev/${COUNTER_NAPPLET_NAME}/index.html`;

type DevNapplet = {
  name: string;
  url: string;
};

type DevRegistry = {
  napplets?: DevNapplet[];
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
      getUserPubkey: () => null,
      getSigner: () => null,
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
      disabledDomains: ['relay', 'outbox'],
    },
    onUnroutedMessage: (info) => {
      console.warn('[stlstr] dropped napplet message', info);
    },
  };
}

async function resolveCounterUrl(): Promise<string> {
  try {
    const response = await fetch('/napplets.dev.json', { cache: 'no-store' });
    if (!response.ok) return COUNTER_URL;

    const registry = (await response.json()) as DevRegistry;
    return (
      registry.napplets?.find((napplet) => napplet.name === COUNTER_NAPPLET_NAME)?.url ??
      COUNTER_URL
    );
  } catch {
    return COUNTER_URL;
  }
}

function NappletFrame() {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef<ShellBridge | null>(null);
  const [status, setStatus] = useState('Loading counter napplet...');

  useEffect(() => {
    let cancelled = false;
    const bridge = createShellBridge(createNoopAdapter());
    bridgeRef.current = bridge;

    const handleMessage = (event: MessageEvent) => bridge.handleMessage(event);
    window.addEventListener('message', handleMessage);

    async function loadNapplet() {
      const iframe = iframeRef.current;
      if (!iframe?.contentWindow) return;

      const url = await resolveCounterUrl();
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(
          `Build the counter napplet first: ${response.status} ${response.statusText}`,
        );
      }

      const html = await response.text();
      if (cancelled) return;

      originRegistry.register(iframe.contentWindow, COUNTER_WINDOW_ID, {
        dTag: COUNTER_NAPPLET_NAME,
        aggregateHash: COUNTER_AGGREGATE_HASH,
      });
      bridge.runtime.sessionRegistry.register(COUNTER_WINDOW_ID, {
        pubkey: '',
        windowId: COUNTER_WINDOW_ID,
        origin: window.location.origin,
        type: COUNTER_NAPPLET_NAME,
        dTag: COUNTER_NAPPLET_NAME,
        aggregateHash: COUNTER_AGGREGATE_HASH,
        registeredAt: Date.now(),
        instanceId: COUNTER_WINDOW_ID,
        provenance: 'nip-5d',
      });

      iframe.srcdoc = injectNappletNamespacePrelude(html, {
        domains: ['storage'],
      });
      setStatus(`Loaded ${COUNTER_NAPPLET_NAME} from ${url}`);
    }

    loadNapplet().catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : 'Failed to load counter napplet.');
    });

    return () => {
      cancelled = true;
      window.removeEventListener('message', handleMessage);
      originRegistry.unregister(COUNTER_WINDOW_ID);
      bridge.runtime.sessionRegistry.unregister(COUNTER_WINDOW_ID);
      bridge.destroy();
      bridgeRef.current = null;
    };
  }, []);

  return (
    <section className="card bg-base-100 shadow-xl border border-base-300 overflow-hidden">
      <div className="card-body gap-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">
              Default napplet
            </p>
            <h1 className="card-title text-3xl">Counter</h1>
          </div>
          <div className="badge badge-primary badge-outline">NAP-STORAGE</div>
        </div>

        <div className="mockup-browser border border-base-300 bg-base-300">
          <div className="mockup-browser-toolbar">
            <div className="input border border-base-300 bg-base-100 text-xs">
              /napplets.dev/counter/index.html
            </div>
          </div>
          <iframe
            ref={iframeRef}
            title="Counter napplet"
            sandbox="allow-scripts"
            className="block h-[520px] w-full border-0 bg-base-100"
          />
        </div>

        <p className="text-sm text-base-content/65">{status}</p>
      </div>
    </section>
  );
}

function App() {
  return (
    <main className="min-h-screen bg-base-200 p-4 sm:p-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="navbar rounded-box border border-base-300 bg-base-100 shadow-sm">
          <div className="flex-1">
            <a className="btn btn-ghost text-xl">stlstr</a>
          </div>
          <div className="flex-none">
            <span className="badge badge-neutral">Kehto host dev mode</span>
          </div>
        </header>

        <NappletFrame />
      </div>
    </main>
  );
}

export default App;
