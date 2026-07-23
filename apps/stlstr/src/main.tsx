import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AccountsProvider, EventStoreProvider } from 'applesauce-react/providers';
import './index.css';
import App from './App.tsx';
import { accountManager } from './services/accounts.ts';
import { eventStore } from './services/nostr.ts';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <EventStoreProvider eventStore={eventStore}>
      <AccountsProvider manager={accountManager}>
        <App />
      </AccountsProvider>
    </EventStoreProvider>
  </StrictMode>,
);
