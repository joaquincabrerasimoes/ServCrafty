import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import './index.css';
import { App } from './App';
import { installPrefsEffects } from './stores/prefs';
import { onUnauthorized } from './api/client';
import { useAuth } from './stores/auth';
import { liveSocket } from './ws/live';
import { queryClient } from './lib/queryClient';

installPrefsEffects();

onUnauthorized(() => {
  if (useAuth.getState().status === 'authenticated') {
    useAuth.getState().clear();
    liveSocket.reset();
    queryClient.clear();
  }
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
