import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Routes } from 'react-router-dom';
import { api } from './api';
import { ErrorLine } from './components/ErrorLine';
import { Shell } from './components/Shell';
import { ToastProvider } from './components/Toast';
import { useT } from './i18n';
import { Agents } from './pages/Agents';
import { Board } from './pages/Board';
import { Login } from './pages/Login';
import { Projects } from './pages/Projects';
import { Proposals } from './pages/Proposals';
import { SessionPage } from './pages/SessionPage';
import { Sessions } from './pages/Sessions';
import { TaskDrawer } from './pages/TaskDrawer';
import { ProjectFilterProvider } from './project-filter';

export function App() {
  const { t } = useT();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<{ authenticated: boolean }>('/me') });
  const logout = useMutation({ mutationFn: () => api('/logout', { method: 'POST' }), onSuccess: () => qc.invalidateQueries() });
  if (me.isLoading) return <div className="screen-center muted">{t.common.loading}</div>;
  // /me failed and we do not hold a signed-in answer: say so, rather than showing a login form that cannot work
  // (this also covers a cached "not signed in" whose refetch fails, e.g. right after a successful login).
  // With a cached signed-in answer a failed background refetch must not unmount the app (it would lose an edit draft or the one-time token).
  if (me.error && !me.data?.authenticated) {
    return (
      <div className="screen-center">
        <div className="login-card">
          <ErrorLine error={me.error} />
          <button type="button" className="btn btn-primary" onClick={() => me.refetch()}>{t.common.retry}</button>
        </div>
      </div>
    );
  }
  if (!me.data?.authenticated) return <Login onDone={() => qc.invalidateQueries()} />;
  return (
    <ToastProvider>
      <ProjectFilterProvider>
        <Shell onLogout={() => logout.mutate()} loggingOut={logout.isPending}>
          <ErrorLine error={logout.error} />
          <Routes>
            {/* the task drawer opens over the board, so a direct /tasks/:id link shows both */}
            <Route path="/" element={<Board />}>
              <Route path="tasks/:id" element={<TaskDrawer />} />
            </Route>
            <Route path="/proposals" element={<Proposals />} />
            <Route path="/sessions" element={<Sessions />} />
            <Route path="/sessions/:id" element={<SessionPage />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Shell>
      </ProjectFilterProvider>
    </ToastProvider>
  );
}

function NotFound() {
  const { t } = useT();
  return (
    <div className="page">
      <h1>{t.app.notFound}</h1>
      <p className="page-sub"><Link to="/">{t.app.toBoard}</Link></p>
    </div>
  );
}
