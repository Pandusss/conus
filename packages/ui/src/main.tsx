import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource-variable/inter';
import { App } from './App';
import { LangProvider } from './i18n';
import { applyTheme, storedTheme } from './theme';
import './styles.css';

applyTheme(storedTheme()); // index.html does this before the CSS loads too; this keeps the two in step
const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true, staleTime: 5_000 } } });
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LangProvider>
      <QueryClientProvider client={qc}>
        <BrowserRouter><App /></BrowserRouter>
      </QueryClientProvider>
    </LangProvider>
  </React.StrictMode>,
);
