import { useSyncExternalStore, useState, type FormEvent, type ReactNode } from 'react';
import { use$ } from 'applesauce-react/hooks';
import { accountManager } from './services/accounts';
import { ARCHETYPES } from './services/intent-map';
import {
  defaultNappletForArchetype,
  discoverCompatibleNapplets,
  overrideFromResolved,
  resolveNappletNaddr,
  type ResolvedNapplet,
} from './services/napplets';
import { getUser } from './services/nostr';
import {
  NETWORK_SETTINGS_LOCKED,
  addBlossomServer,
  addRelay,
  getAppRelays,
  getFallbackBlossomServers,
  getLookupRelays,
  getSettings,
  removeBlossomServer,
  removeNappletOverride,
  removeRelay,
  resetNappletOverrides,
  resetSettings,
  setNappletOverride,
  subscribeToSettings,
  updateSettings,
  type NappletUpdateBehavior,
  type ThemePreference,
} from './services/settings';

const THEME_OPTIONS: Array<{ id: ThemePreference; label: string }> = [
  { id: 'system', label: 'Match my system' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

const UPDATE_BEHAVIOR_OPTIONS: Array<{
  id: NappletUpdateBehavior;
  label: string;
  hint: string;
}> = [
  { id: 'banner', label: 'Ask me first', hint: 'Show a banner when a napplet wants new access.' },
  {
    id: 'auto-grant',
    label: 'Grant automatically',
    hint: 'Trust updated napplets without prompting.',
  },
  {
    id: 'silent-reprompt',
    label: 'Re-ask quietly',
    hint: 'Re-request access without an interruption banner.',
  },
];

type SettingsTab = 'appearance' | 'network' | 'napplets' | 'advanced';

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'network', label: 'Network' },
  { id: 'napplets', label: 'Napplets' },
  { id: 'advanced', label: 'Advanced' },
];

function useSettings() {
  return useSyncExternalStore(subscribeToSettings, getSettings, getSettings);
}

function relayHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-4 border-b border-base-300 py-6 last:border-b-0 lg:grid-cols-[18rem_1fr]">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-1 max-w-sm text-sm text-base-content/65">{description}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function UrlList({
  values,
  emptyLabel,
  onRemove,
}: {
  values: string[];
  emptyLabel: string;
  onRemove?: (value: string) => void;
}) {
  if (values.length === 0) {
    return <p className="text-sm text-base-content/60">{emptyLabel}</p>;
  }

  return (
    <ul className="divide-y divide-base-300 rounded-box bg-base-100 ring-1 ring-base-300/70">
      {values.map((value) => (
        <li
          key={value}
          className="flex items-center justify-between gap-3 px-3 py-2"
        >
          <div className="min-w-0">
            <div className="truncate font-medium">{relayHost(value)}</div>
            <div className="truncate font-mono text-xs text-base-content/55">{value}</div>
          </div>
          {onRemove && (
            <button
              className="btn btn-ghost btn-sm shrink-0"
              aria-label={`Remove ${value}`}
              onClick={() => onRemove(value)}
            >
              Remove
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function AddUrlForm({
  label,
  placeholder,
  onAdd,
  disabled = false,
}: {
  label: string;
  placeholder: string;
  onAdd: (value: string) => boolean;
  disabled?: boolean;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!value.trim()) return;

    if (onAdd(value)) {
      setValue('');
      setError('');
    } else {
      setError('That address is not valid, or it is already in the list.');
    }
  }

  return (
    <form className="grid gap-2" onSubmit={handleSubmit}>
      <div className="join">
        <input
          className="input join-item w-full font-mono text-sm"
          aria-label={label}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onChange={(event) => {
            setValue(event.target.value);
            setError('');
          }}
        />
        <button className="btn btn-primary join-item" disabled={disabled || !value.trim()}>
          Add
        </button>
      </div>
      {error && <p className="text-sm text-error">{error}</p>}
    </form>
  );
}

function AccountRelays() {
  const active = use$(accountManager.active$);
  const user = active ? getUser(active.pubkey) : null;
  const mailboxes = use$(() => user?.mailboxes$, [user?.pubkey]);

  if (!active) {
    return (
      <p className="text-sm text-base-content/60">
        Login to see the relays published on your Nostr profile.
      </p>
    );
  }

  const outboxes = mailboxes?.outboxes ?? [];
  const inboxes = mailboxes?.inboxes ?? [];

  if (outboxes.length === 0 && inboxes.length === 0) {
    return (
      <p className="text-sm text-base-content/60">
        Your account has not published a relay list yet, so STLstr uses the backup relays below.
      </p>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <h3 className="text-sm font-semibold">Where your work is published</h3>
        <UrlList values={outboxes} emptyLabel="No publish relays listed." />
      </div>
      <div className="grid gap-2">
        <h3 className="text-sm font-semibold">Where others reach you</h3>
        <UrlList values={inboxes} emptyLabel="No inbox relays listed." />
      </div>
      <p className="text-sm text-base-content/60">
        This list comes from your Nostr account. Edit it in a Nostr client that manages relay lists.
      </p>
    </div>
  );
}

function AccountMediaServers() {
  const active = use$(accountManager.active$);
  const user = active ? getUser(active.pubkey) : null;
  const servers = use$(() => user?.blossomServers$, [user?.pubkey]);
  const values = (servers ?? []).map((server) => server.toString());

  if (!active) {
    return (
      <p className="text-sm text-base-content/60">
        Login to see the media servers published on your Nostr profile.
      </p>
    );
  }

  if (values.length === 0) {
    return (
      <p className="text-sm text-base-content/60">
        Your account has no media server list, so uploads use the backup servers below.
      </p>
    );
  }

  return (
    <div className="grid gap-2">
      <UrlList values={values} emptyLabel="No media servers listed." />
      <p className="text-sm text-base-content/60">
        Uploads go to these servers. The backup servers below are only used when this list is empty.
      </p>
    </div>
  );
}

function archetypeLabel(archetype: string): string {
  if (archetype === 'profile') return 'User profile';
  return ARCHETYPES[archetype]?.title ?? archetype;
}

function NappletOverrideRow({ archetype }: { archetype: string }) {
  const settings = useSettings();
  const entry = ARCHETYPES[archetype];
  const fallback = defaultNappletForArchetype(archetype);
  const override = settings.nappletOverrides[archetype];
  const [naddr, setNaddr] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [candidates, setCandidates] = useState<ResolvedNapplet[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  async function handleUseOverride(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = naddr.trim();
    if (!value) return;

    setBusy(true);
    setStatus('Checking napplet...');
    try {
      const resolved = await resolveNappletNaddr(value, archetype);
      const next = overrideFromResolved(resolved);
      if (!next) throw new Error('That napplet could not be stored as an override.');
      setNappletOverride(archetype, next);
      setNaddr('');
      setStatus(`Using ${resolved.title} for ${entry.title}.`);
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : 'Could not use that napplet.');
    } finally {
      setBusy(false);
    }
  }

  function applyResolvedOverride(resolved: ResolvedNapplet) {
    const next = overrideFromResolved(resolved);
    if (!next) {
      setStatus('That napplet could not be stored as an override.');
      return;
    }
    setNappletOverride(archetype, next);
    setStatus(`Using ${resolved.title} for ${entry.title}.`);
  }

  async function handleDiscover() {
    setDiscovering(true);
    setStatus('Searching lookup relays...');
    try {
      const found = await discoverCompatibleNapplets(archetype);
      setCandidates(found);
      setPickerOpen(found.length > 0);
      setStatus(found.length ? `Found ${found.length} napplet.` : 'No napplets found.');
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : 'Could not search for napplets.');
    } finally {
      setDiscovering(false);
    }
  }

  return (
    <div className="grid gap-3 border-b border-base-300 py-4 last:border-b-0 xl:grid-cols-[minmax(12rem,18rem)_minmax(12rem,1fr)_minmax(18rem,1.3fr)_auto] xl:items-center">
      <div className="min-w-0">
        <h3 className="font-semibold">{archetypeLabel(archetype)}</h3>
        <p className="mt-1 line-clamp-2 text-sm text-base-content/65">{entry.description}</p>
      </div>

      <div className="min-w-0 text-sm">
        <div className="text-xs font-medium uppercase tracking-wide text-base-content/45">Handler</div>
        <div className="mt-1 truncate font-medium">{override?.title ?? fallback?.title ?? entry.title}</div>
        <div className="truncate font-mono text-xs text-base-content/55">
          {override ? override.dTag : `default:${fallback?.dTag ?? entry.dTag}`}
        </div>
      </div>

      <form className="grid min-w-0 gap-2" onSubmit={handleUseOverride}>
        <div className="join">
          <input
            className="input join-item w-full font-mono text-sm"
            aria-label={`Napplet naddr for ${archetypeLabel(archetype)}`}
            placeholder="naddr1..."
            value={naddr}
            disabled={busy}
            onChange={(event) => {
              setNaddr(event.target.value);
              setStatus('');
            }}
          />
          <button className="btn btn-primary join-item" disabled={busy || !naddr.trim()}>
            {busy ? 'Checking' : 'Use'}
          </button>
        </div>
        {status ? <p className="text-sm text-base-content/65">{status}</p> : null}
      </form>

      <div className="flex flex-wrap gap-2 xl:justify-end">
        <button className="btn btn-outline btn-sm w-fit" disabled={discovering} onClick={handleDiscover}>
          {discovering ? 'Searching relays' : 'Find napplets'}
        </button>
        <button
          className="btn btn-ghost btn-sm"
          disabled={!override}
          onClick={() => {
            removeNappletOverride(archetype);
            setStatus('Restored the default napplet.');
          }}
        >
          Reset
        </button>
      </div>

      {pickerOpen ? (
        <div className="modal modal-open" role="dialog" aria-modal="true">
          <div className="modal-box max-w-3xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold">Choose a napplet for {archetypeLabel(archetype)}</h3>
                <p className="mt-1 text-sm text-base-content/65">
                  Showing all loadable napplets found on your lookup relays. Compatibility badges
                  are advisory until published napplets advertise archetypes reliably.
                </p>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => setPickerOpen(false)}>
                Close
              </button>
            </div>

            <ul className="mt-4 grid max-h-[60vh] gap-2 overflow-auto pr-1">
              {candidates.map((candidate) => (
                <li
                  key={`${candidate.pubkey}:${candidate.dTag}`}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-box border border-base-300 p-3 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="font-medium">{candidate.title}</div>
                      <span
                        className={`badge badge-sm ${candidate.compatibleWithArchetype ? 'badge-success' : 'badge-warning'}`}
                      >
                        {candidate.compatibleWithArchetype ? 'advertises this page' : 'not advertised'}
                      </span>
                    </div>
                    {candidate.description ? (
                      <div className="mt-1 text-base-content/65">{candidate.description}</div>
                    ) : null}
                    <div className="mt-1 truncate font-mono text-xs text-base-content/55">
                      {candidate.dTag}
                    </div>
                  </div>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => {
                      applyResolvedOverride(candidate);
                      setPickerOpen(false);
                    }}
                  >
                    Use
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <button
            className="modal-backdrop"
            aria-label="Close napplet picker"
            onClick={() => setPickerOpen(false)}
          >
            close
          </button>
        </div>
      ) : null}
    </div>
  );
}

function NappletOverrides() {
  const settings = useSettings();
  const overrideCount = Object.keys(settings.nappletOverrides).length;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-base-300 pb-4">
        <div>
          <div className="font-medium">Napplet defaults</div>
          <p className="mt-1 text-sm text-base-content/65">
            {overrideCount
              ? `${overrideCount} page override${overrideCount === 1 ? '' : 's'} active.`
              : 'Every page is using the built-in default napplet.'}
          </p>
        </div>
        <button className="btn btn-outline btn-sm" disabled={!overrideCount} onClick={resetNappletOverrides}>
          Reset all to defaults
        </button>
      </div>
      <div>
        {Object.keys(ARCHETYPES).map((archetype) => (
          <NappletOverrideRow key={archetype} archetype={archetype} />
        ))}
      </div>
      <p className="text-sm text-base-content/60">
        Relay search scans recent NIP-5A manifests on your lookup relays. Until published napplets
        advertise archetypes reliably, the picker shows every loadable napplet it finds.
      </p>
    </div>
  );
}

export default function SettingsView() {
  const settings = useSettings();
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance');
  const [resetConfirmed, setResetConfirmed] = useState(false);

  function handleReset() {
    if (!resetConfirmed) {
      setResetConfirmed(true);
      return;
    }
    resetSettings();
    setResetConfirmed(false);
  }

  return (
    <div className="grid w-full gap-4 px-4 py-5 sm:px-6 lg:px-8">
      <div className="flex gap-1 overflow-x-auto border-b border-base-300" role="tablist">
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            className={`px-4 py-3 text-sm font-medium ${activeTab === tab.id ? 'border-b-2 border-primary text-primary' : 'text-base-content/65 hover:text-base-content'}`}
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="grid gap-6">
        {activeTab === 'appearance' && (
          <Section title="Appearance" description="Choose how STLstr looks.">
            <div className="join">
              {THEME_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  className={`btn join-item ${settings.theme === option.id ? 'btn-primary' : 'btn-outline'}`}
                  aria-label={option.label}
                  aria-pressed={settings.theme === option.id}
                  onClick={() => updateSettings({ theme: option.id })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </Section>
        )}

        {activeTab === 'network' &&
          (NETWORK_SETTINGS_LOCKED ? (
            <Section
              title="Relays and media servers"
              description="This is a development build, so STLstr talks only to your local relay and Blossom server."
            >
              <div className="alert alert-info text-sm">
                <span>
                  These are pinned by the dev server and cannot be changed here. Account relay and
                  media server lists are ignored while running in development.
                </span>
              </div>
              <div className="grid gap-2">
                <h3 className="text-sm font-semibold">Relays</h3>
                <UrlList values={getAppRelays()} emptyLabel="No relay configured." />
              </div>
              <div className="grid gap-2">
                <h3 className="text-sm font-semibold">Lookup relays</h3>
                <UrlList values={getLookupRelays()} emptyLabel="No lookup relay configured." />
              </div>
              <div className="grid gap-2">
                <h3 className="text-sm font-semibold">Media servers</h3>
                <UrlList
                  values={getFallbackBlossomServers()}
                  emptyLabel="No media server configured."
                />
              </div>
            </Section>
          ) : (
            <>
              <Section
                title="Your relays"
                description="Relays your account publishes to and receives messages on. STLstr uses these whenever your account has them."
              >
                <AccountRelays />
              </Section>

              <Section
                title="Backup relays"
                description="Used only for accounts with no relay list of their own, including while you are logged out."
              >
                <UrlList
                  values={settings.appRelays}
                  emptyLabel="No backup relays. STLstr will fall back to its built-in relays."
                  onRemove={(value) => removeRelay('appRelays', value)}
                />
                <AddUrlForm
                  label="Add an app relay"
                  placeholder="wss://relay.example.com"
                  onAdd={(value) => addRelay('appRelays', value)}
                />
              </Section>

              <Section
                title="Your media servers"
                description="Where your images and model files are stored. Uploads go here whenever your account has a list."
              >
                <AccountMediaServers />
              </Section>

              <Section
                title="Backup media servers"
                description="Used for uploads only when your account has no media server list of its own."
              >
                <UrlList
                  values={settings.blossomServers}
                  emptyLabel="No backup media servers. Uploads will fail unless your account lists one."
                  onRemove={removeBlossomServer}
                />
                <AddUrlForm
                  label="Add a media server"
                  placeholder="https://blossom.example.com"
                  onAdd={addBlossomServer}
                />
              </Section>
            </>
          ))}

        {activeTab === 'napplets' && (
          <Section
            title="Napplet overrides"
            description="Choose which compatible napplet renders each STLstr page."
          >
            <NappletOverrides />
          </Section>
        )}

        {activeTab === 'advanced' && (
          <Section title="Advanced" description="Lower-level runtime and reset controls.">
            <div className="grid gap-6">
              {!NETWORK_SETTINGS_LOCKED && (
                <div className="grid gap-3">
                  <div>
                    <h2 className="font-semibold">Lookup relays</h2>
                    <p className="mt-1 text-sm text-base-content/65">
                      Used to find profiles and relay lists.
                    </p>
                  </div>
                  <UrlList
                    values={settings.lookupRelays}
                    emptyLabel="No lookup relays. STLstr will fall back to its built-in relays."
                    onRemove={(value) => removeRelay('lookupRelays', value)}
                  />
                  <AddUrlForm
                    label="Add a lookup relay"
                    placeholder="wss://purplepag.es"
                    onAdd={(value) => addRelay('lookupRelays', value)}
                  />
                  <p className="text-sm text-base-content/60">
                    Lookup relay changes apply the next time STLstr is reloaded.
                  </p>
                </div>
              )}

              <label className="fieldset">
                <span className="fieldset-legend">When an app asks for new access</span>
                <select
                  className="select w-full"
                  value={settings.nappletUpdateBehavior}
                  onChange={(event) =>
                    updateSettings({
                      nappletUpdateBehavior: event.target.value as NappletUpdateBehavior,
                    })
                  }
                >
                  {UPDATE_BEHAVIOR_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <span className="fieldset-label">
                  {
                    UPDATE_BEHAVIOR_OPTIONS.find(
                      (option) => option.id === settings.nappletUpdateBehavior,
                    )?.hint
                  }
                </span>
              </label>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  className={`btn btn-sm ${resetConfirmed ? 'btn-error' : 'btn-outline'}`}
                  onClick={handleReset}
                >
                  {resetConfirmed ? 'Confirm reset' : 'Reset settings to defaults'}
                </button>
                {resetConfirmed && (
                  <button className="btn btn-ghost btn-sm" onClick={() => setResetConfirmed(false)}>
                    Cancel
                  </button>
                )}
              </div>
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}
