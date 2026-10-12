import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { TaskDto } from './api';
import { ToastProvider } from './components/Toast';
import { LangProvider } from './i18n';
import { ProjectFilterProvider } from './project-filter';

/**
 * Renders a page inside a fresh query client (no retries), a memory router and the app's providers (language, toasts,
 * project filter); `route` mounts it under a path pattern. The language is Russian unless a test stores another one.
 */
export function renderPage(ui: ReactElement, opts: { path?: string; route?: string; client?: QueryClient } = {}) {
  const client = opts.client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = opts.route ? <Routes><Route path={opts.route} element={ui} /></Routes> : ui;
  const utils = render(
    <LangProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[opts.path ?? '/']}>
          <ToastProvider><ProjectFilterProvider>{page}</ProjectFilterProvider></ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </LangProvider>,
  );
  return { client, ...utils };
}

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
export const apiError = (status: number, code: string, message = 'server message') => json({ error: { code, message } }, status);

/** Non-GET calls recorded by a fetch spy, as `METHOD url` plus the raw body. */
export function mutations(f: { mock: { calls: unknown[][] } }) {
  return f.mock.calls
    .filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') !== 'GET')
    .map(([url, init]) => ({ call: `${(init as RequestInit).method} ${String(url)}`, body: (init as RequestInit).body as string | undefined }));
}

/** A task as the API sends it, with every field filled; `over` replaces some. */
export function taskDto(over: Partial<TaskDto> = {}): TaskDto {
  return {
    id: 't1', ref: 'WB-1', projectKey: 'WB', projectName: 'Web', title: 'Задача', description: '', status: 'todo', type: 'task',
    parentId: null, parentRef: null, result: null, blockReason: null, sourceQuote: null, claimedBySessionId: null, holder: null,
    subtaskCount: 0, commitCount: 0, version: 1, createdAt: '2026-10-08T10:00:00Z', updatedAt: '2026-10-08T10:00:00Z', ...over,
  };
}
