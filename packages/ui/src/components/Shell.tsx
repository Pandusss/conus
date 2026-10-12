import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Activity, Bot, FolderKanban, Inbox, LayoutGrid, LogOut, Menu as MenuIcon, Moon, Sun, X } from 'lucide-react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api, type ProjectDto, type SessionDto, type TaskDto } from '../api';
import { BRAND_CELLS } from '../brand-cells';
import { useT } from '../i18n';
import { useProjectFilter } from '../project-filter';
import { useTheme } from '../theme';
import { HealthBanner } from './HealthBanner';
import { LangSwitch } from './LangSwitch';
import { useEscapeLayer } from './layers';

/** The Conus mark: Rule 30 grown from one cell (see scripts/gen-icon.mjs). */
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 64 64" width="24" height="24" aria-hidden="true">
      <rect width="64" height="64" rx="15" fill="currentColor" />
      <g fill="var(--on-accent)">
        {BRAND_CELLS.map(([x, y, width, height, rx]) => <rect key={`${x},${y}`} x={x} y={y} width={width} height={height} rx={rx} />)}
      </g>
    </svg>
  );
}

/** The app frame: a sidebar (an off-canvas drawer up to 900px wide), the health banner and the page. */
export function Shell({ children, onLogout, loggingOut }: { children: ReactNode; onLogout: () => void; loggingOut: boolean }) {
  const { t } = useT();
  const [navOpen, setNavOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setNavOpen(false), [pathname]);
  useEscapeLayer(() => setNavOpen(false), navOpen);
  return (
    <div className="shell">
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label={t.shell.openMenu} aria-expanded={navOpen} aria-controls="sidebar" onClick={() => setNavOpen(true)}>
          <MenuIcon size={20} aria-hidden />
        </button>
        <span className="brand"><BrandMark />Conus</span>
      </header>
      {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />}
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} onLogout={onLogout} loggingOut={loggingOut} />
      <div className="content">
        <HealthBanner />
        <main className="main">{children}</main>
      </div>
    </div>
  );
}

function Sidebar({ open, onClose, onLogout, loggingOut }: { open: boolean; onClose: () => void; onLogout: () => void; loggingOut: boolean }) {
  const { t } = useT();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const { project, setProject } = useProjectFilter();
  const proposals = useQuery({ queryKey: ['tasks', 'proposed'], queryFn: () => api<{ tasks: TaskDto[] }>('/tasks?status=proposed'), refetchInterval: 60_000 });
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api<{ sessions: SessionDto[] }>('/sessions'), refetchInterval: 30_000 });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<{ projects: ProjectDto[] }>('/projects') });
  const proposalCount = proposals.data?.tasks?.length ?? 0;
  const anyActive = (sessions.data?.sessions ?? []).some((s) => s.state === 'active');
  const onBoard = pathname === '/' || pathname.startsWith('/tasks/');
  const pick = (key: string) => { setProject(key); nav('/'); };
  const item = ({ isActive }: { isActive: boolean }) => `nav-item${isActive ? ' is-active' : ''}`;
  return (
    <aside id="sidebar" className={`sidebar${open ? ' is-open' : ''}`}>
      <div className="sidebar-head">
        <span className="brand"><BrandMark />Conus</span>
        <button type="button" className="icon-btn sidebar-close" aria-label={t.shell.closeMenu} onClick={onClose}><X size={18} aria-hidden /></button>
      </div>
      <nav className="nav" aria-label={t.shell.sections}>
        <NavLink to="/" className={() => item({ isActive: onBoard })} end><LayoutGrid size={16} aria-hidden />{t.shell.board}</NavLink>
        <NavLink to="/proposals" className={item}>
          <Inbox size={16} aria-hidden />{t.shell.proposals}
          {proposalCount > 0 && <span className="nav-badge" aria-label={t.shell.newCount(proposalCount)}>{proposalCount}</span>}
        </NavLink>
        <NavLink to="/sessions" className={item}>
          <Activity size={16} aria-hidden />{t.shell.sessions}
          {anyActive && <span className="nav-live" title={t.shell.activeSessions}><span className="sr-only">{t.shell.activeNow}</span></span>}
        </NavLink>
        <NavLink to="/agents" className={item}><Bot size={16} aria-hidden />{t.shell.agents}</NavLink>
        <NavLink to="/projects" className={item}><FolderKanban size={16} aria-hidden />{t.shell.projects}</NavLink>
      </nav>
      <div className="sidebar-section">
        <div className="sidebar-title">{t.shell.projects}</div>
        <button type="button" className={`project-item${onBoard && !project ? ' is-active' : ''}`} onClick={() => pick('')}>
          <span className="project-name">{t.common.allProjects}</span>
        </button>
        {(projects.data?.projects ?? []).map((p) => (
          <button
            key={p.id} type="button" title={`${p.name} (${p.key})`}
            className={`project-item${onBoard && project === p.key ? ' is-active' : ''}`} onClick={() => pick(p.key)}
          >
            <span className="project-key">{p.key}</span>
            <span className="project-name">{p.name}</span>
            <span className="count" aria-label={t.shell.openCount(p.openCount)}>{p.openCount}</span>
          </button>
        ))}
      </div>
      <div className="sidebar-foot">
        <ThemeToggle />
        <LangSwitch row />
        <button type="button" className="side-btn" disabled={loggingOut} onClick={onLogout}><LogOut size={16} aria-hidden />{t.shell.logout}</button>
      </div>
    </aside>
  );
}

export function ThemeToggle() {
  const { t } = useT();
  const { theme, toggle } = useTheme();
  return (
    <button type="button" role="switch" aria-checked={theme === 'dark'} className="side-btn" onClick={toggle}>
      {theme === 'dark' ? <Moon size={16} aria-hidden /> : <Sun size={16} aria-hidden />}{t.shell.darkTheme}
      <span className="switch" aria-hidden="true" />
    </button>
  );
}
