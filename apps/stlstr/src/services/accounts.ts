import { AccountManager, type IAccount, type SerializedAccount } from 'applesauce-accounts';
import {
  ExtensionAccount,
  NostrConnectAccount,
  registerCommonAccountTypes,
} from 'applesauce-accounts/accounts';
import type { ISigner } from 'applesauce-signers';
import { NostrConnectSigner } from 'applesauce-signers/signers';
import { NOSTR_EXTRA_RELAYS, relayPool } from './nostr';

const ACCOUNTS_STORAGE_KEY = 'stlstr.accounts.v1';
const ACTIVE_ACCOUNT_STORAGE_KEY = 'stlstr.activeAccount.v1';

export const NOSTR_CONNECT_RELAYS = NOSTR_EXTRA_RELAYS;
export const NOSTR_CONNECT_PERMISSIONS = [
  'get_public_key',
  ...NostrConnectSigner.buildSigningPermissions([0, 1, 3, 10002]),
];

export type AccountLoginMethod = 'extension' | 'bunker' | 'nostrconnect';

export type AccountMetadata = {
  name: string;
  loginMethod: AccountLoginMethod;
  createdAt: number;
};

export type StlstrAccount = IAccount<ISigner, unknown, AccountMetadata>;

export const accountManager = new AccountManager<AccountMetadata>();

registerCommonAccountTypes(accountManager);
NostrConnectSigner.pool = relayPool;

function readStoredAccounts() {
  try {
    return JSON.parse(localStorage.getItem(ACCOUNTS_STORAGE_KEY) || '[]') as SerializedAccount<
      unknown,
      AccountMetadata
    >[];
  } catch {
    return [];
  }
}

function persistAccounts() {
  localStorage.setItem(ACCOUNTS_STORAGE_KEY, JSON.stringify(accountManager.toJSON()));
}

export const accountManagerReady = (async () => {
  try {
    await accountManager.fromJSON(readStoredAccounts());
  } catch (cause) {
    console.warn('[stlstr] failed to restore saved accounts', cause);
  }

  const activeId = localStorage.getItem(ACTIVE_ACCOUNT_STORAGE_KEY);
  if (activeId && accountManager.getAccount(activeId)) accountManager.setActive(activeId);

  accountManager.accounts$.subscribe(() => {
    persistAccounts();
  });

  accountManager.active$.subscribe((account) => {
    if (account) localStorage.setItem(ACTIVE_ACCOUNT_STORAGE_KEY, account.id);
    else localStorage.removeItem(ACTIVE_ACCOUNT_STORAGE_KEY);
  });
})();

function addAndActivate(account: StlstrAccount) {
  accountManager.addAccount(account);
  accountManager.setActive(account);
  persistAccounts();
}

export async function loginWithExtension() {
  const account = await ExtensionAccount.fromExtension<AccountMetadata>();
  account.metadata = {
    name: 'Browser extension',
    loginMethod: 'extension',
    createdAt: Date.now(),
  };
  addAndActivate(account);
  return account;
}

export async function loginWithBunkerUri(uri: string) {
  const signer = await NostrConnectSigner.fromBunkerURI(uri, {
    permissions: NOSTR_CONNECT_PERMISSIONS,
  });
  const pubkey = await signer.getPublicKey();
  const account = new NostrConnectAccount<AccountMetadata>(pubkey, signer);
  account.metadata = {
    name: 'Remote signer',
    loginMethod: 'bunker',
    createdAt: Date.now(),
  };
  addAndActivate(account);
  return account;
}

export function createNostrConnectLogin() {
  const signer = new NostrConnectSigner({
    relays: NOSTR_CONNECT_RELAYS,
  });
  const uri = signer.getNostrConnectURI({
    name: 'STLstr',
    url: window.location.origin,
    permissions: NOSTR_CONNECT_PERMISSIONS,
  });

  return { signer, uri };
}

export async function finishNostrConnectLogin(signer: NostrConnectSigner) {
  const pubkey = await signer.getPublicKey();
  const account = new NostrConnectAccount<AccountMetadata>(pubkey, signer);
  account.metadata = {
    name: 'Remote signer',
    loginMethod: 'nostrconnect',
    createdAt: Date.now(),
  };
  addAndActivate(account);
  return account;
}
