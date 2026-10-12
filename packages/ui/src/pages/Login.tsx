import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { api, HttpError } from '../api';
import { errorText } from '../components/ErrorLine';
import { LangSwitch } from '../components/LangSwitch';
import { BrandMark } from '../components/Shell';
import { useT } from '../i18n';

/** Sign-in, or the first-run setup (setup code + owner password) while the server has no owner yet. */
export function Login({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  // An older server without /setup, or any failure here, simply means "sign in".
  const setup = useQuery({ queryKey: ['setup'], queryFn: () => api<{ needed: boolean }>('/setup'), retry: false });
  const [setUpElsewhere, setSetUpElsewhere] = useState(false);
  if (setup.isLoading) return null;
  if (setup.data?.needed && !setUpElsewhere) {
    return <SetupForm onDone={onDone} onAlreadySetUp={() => { setSetUpElsewhere(true); void qc.invalidateQueries({ queryKey: ['setup'] }); }} />;
  }
  return <SignInForm onDone={onDone} notice={setUpElsewhere} />;
}

function Card({ children, onSubmit }: { children: ReactNode; onSubmit: (e: FormEvent) => void }) {
  return (
    <div className="screen-center">
      <form className="login-card" onSubmit={onSubmit}>
        <div className="login-head">
          <div className="brand brand-lg"><BrandMark />Conus</div>
          <LangSwitch />
        </div>
        {children}
      </form>
    </div>
  );
}

function SignInForm({ onDone, notice }: { onDone: () => void; notice: boolean }) {
  const { t } = useT();
  const [password, setPassword] = useState('');
  // the failure itself, not its text, so the message follows a language switch
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const fieldId = useId();
  // On the login endpoint 'unauthorized' means a wrong password, not an expired session.
  const message = !error ? null
    : error instanceof HttpError && error.code === 'unauthorized' ? t.login.wrongPassword : errorText(error, t);
  return (
    <Card onSubmit={async (e) => {
      e.preventDefault();
      if (busy) return;
      setError(null);
      setBusy(true);
      try { await api('/login', { method: 'POST', json: { password } }); onDone(); }
      catch (err) { setError(err); } finally { setBusy(false); }
    }}>
      <p className="muted">{notice ? t.setup.alreadySetUp : t.login.tagline}</p>
      <div className="field">
        <label htmlFor={fieldId}>{t.login.password}</label>
        <input id={fieldId} type="password" placeholder={t.login.password} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
      </div>
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? t.login.submitting : t.login.submit}</button>
      {message && <p className="error" role="alert">{message}</p>}
    </Card>
  );
}

type SetupProblem = 'tooShort' | 'mismatch' | 'wrongCode' | { error: unknown };

function SetupForm({ onDone, onAlreadySetUp }: { onDone: () => void; onAlreadySetUp: () => void }) {
  const { t } = useT();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problem, setProblem] = useState<SetupProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { code: useId(), password: useId(), confirm: useId() };
  const message = problem === null ? null : typeof problem === 'string' ? t.setup[problem] : errorText(problem.error, t);
  return (
    <Card onSubmit={async (e) => {
      e.preventDefault();
      if (busy) return;
      if (password.length < 8) return setProblem('tooShort');
      if (password !== confirm) return setProblem('mismatch');
      setProblem(null);
      setBusy(true);
      try {
        await api('/setup', { method: 'POST', json: { code, password } });
        onDone();
      } catch (err) {
        if (err instanceof HttpError && err.code === 'already_set_up') onAlreadySetUp();
        else setProblem(err instanceof HttpError && err.code === 'wrong_setup_code' ? 'wrongCode' : { error: err });
      } finally {
        setBusy(false);
      }
    }}>
      <h1 className="login-title">{t.setup.title}</h1>
      <p className="muted">{t.setup.text}</p>
      <div className="field">
        <label htmlFor={ids.code}>{t.setup.code}</label>
        <input id={ids.code} placeholder="ABCD-EFGH" autoComplete="off" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
      </div>
      <div className="field">
        <label htmlFor={ids.password}>{t.setup.password}</label>
        <input id={ids.password} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={ids.confirm}>{t.setup.confirm}</label>
        <input id={ids.confirm} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </div>
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? t.setup.submitting : t.setup.submit}</button>
      {message && <p className="error" role="alert">{message}</p>}
    </Card>
  );
}
