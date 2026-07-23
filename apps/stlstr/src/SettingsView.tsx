import { useSyncExternalStore, useState, type FormEvent, type ReactNode } from 'react';
import { use$ } from 'applesauce-react/hooks';
import { accountManager } from './services/accounts';
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
  removeRelay,
  resetSettings,
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
    <section className="card bg-base-100 shadow-sm">
      <div className="card-body gap-4">
        <div>
          <h2 className="card-title text-lg">{title}</h2>
          <p className="mt-1 text-sm text-base-content/65">{description}</p>
        </div>
        {children}
      </div>
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
    <ul className="grid gap-2">
      {values.map((value) => (
        <li
          key={value}
          className="flex items-center justify-between gap-3 rounded-box border border-base-300 px-3 py-2"
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

export default function SettingsView() {
  const settings = useSettings();
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
    <div className="mx-auto grid w-full max-w-3xl gap-6 p-4 sm:p-6">
      <header>
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="mt-2 text-base-content/65">These settings are saved in this browser only.</p>
      </header>

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

      {NETWORK_SETTINGS_LOCKED ? (
        <Section
          title="Relays and media servers"
          description="This is a development build, so STLstr talks only to your local relay and Blossom server."
        >
          <div className="alert alert-info text-sm">
            <span>
              These are pinned by the dev server and cannot be changed here. Account relay and media
              server lists are ignored while running in development.
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
      )}

      <details className="collapse-arrow collapse border border-base-300 bg-base-100">
        <summary className="collapse-title font-medium">Advanced</summary>
        <div className="collapse-content grid gap-6">
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
      </details>
    </div>
  );
}
