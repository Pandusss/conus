import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { readStored, writeStored } from './storage';

const KEY = 'conus.project';

interface ProjectFilter {
  /** The selected project key; '' means all projects. */
  project: string;
  setProject: (key: string) => void;
}

const Ctx = createContext<ProjectFilter | null>(null);

/** The board's project filter, shared by the sidebar, the board and the projects page, and remembered in `conus.project`. */
export function ProjectFilterProvider({ children }: { children: ReactNode }) {
  const [project, setState] = useState<string>(() => readStored(KEY) ?? '');
  const setProject = useCallback((key: string) => {
    setState(key);
    writeStored(KEY, key || null);
  }, []);
  const value = useMemo(() => ({ project, setProject }), [project, setProject]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProjectFilter(): ProjectFilter {
  const v = useContext(Ctx);
  if (!v) throw new Error('useProjectFilter needs a ProjectFilterProvider');
  return v;
}
