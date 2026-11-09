import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { ExternalLink, Send, Sparkles, Unlink } from 'lucide-react';
import { api, type SettingsDto } from '../api';
import { ErrorLine, useActionError } from '../components/ErrorLine';
import { useToast } from '../components/Toast';
import { useT } from '../i18n';

type Patch = Partial<{ time_zone: string; digest_time: string; quiet_from: string; quiet_to: string; notify_review: boolean; notify_blocked: boolean; manager_auto: boolean; remind_every_hours: number }>;

/** How often the bot may remind: off, or every this many hours. */
const REMIND_HOURS = [0, 1, 2, 3, 4, 6, 8, 12];

/** Every IANA zone the browser knows, the browser's own first. */
function timeZones(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const own = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return [...new Set([current, own, 'UTC', ...all])];
}

/** The manager's schedule, its Telegram link and whether it may change priorities itself. */
export function Settings() {
  const { t } = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const { error, track } = useActionError();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsDto>('/settings') });
  const [link, setLink] = useState<{ url: string } | null>(null);
  const save = useMutation({
    mutationFn: (p: Patch) => api<SettingsDto>('/settings', { method: 'PATCH', json: p }),
    onSuccess: (d) => { qc.setQueryData(['settings'], d); toast(t.settings.saved); }, ...track,
  });
  const makeLink = useMutation({
    mutationFn: () => api<{ url: string }>('/telegram/link', { method: 'POST' }),
    onSuccess: (d) => setLink(d), ...track,
  });
  const unlink = useMutation({
    mutationFn: () => api<SettingsDto>('/telegram/unlink', { method: 'POST' }),
    onSuccess: (d) => { qc.setQueryData(['settings'], d); setLink(null); toast(t.settings.unlinked); }, ...track,
  });
  const test = useMutation({ mutationFn: () => api('/telegram/test', { method: 'POST' }), onSuccess: () => toast(t.settings.tested), ...track });
  const ids = { tz: useId(), digest: useId(), remind: useId(), from: useId(), to: useId() };
  const d = q.data;
  const s = d?.settings;
  const busy = save.isPending;
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div className="page page-narrow">
      <div className="page-head"><h1>{t.settings.title}</h1></div>
      <p className="page-sub">{t.settings.sub}</p>
      <ErrorLine error={error ?? q.error} />
      {!d || !s ? (!q.error && <p className="muted">{t.common.loading}</p>) : (
        <div className="stack">
          <section className="panel settings-card">
            <h2><Send size={16} aria-hidden />{t.settings.telegram}</h2>
            {!d.telegram.configured ? <p className="muted">{t.settings.telegramOff}</p> : (
              <>
                {d.telegram.error && <p className="error">{d.telegram.error}</p>}
                <p>{s.telegramLinked
                  ? t.settings.telegramLinked(s.telegramUsername ? `@${s.telegramUsername}` : 'Telegram')
                  : t.settings.telegramNotLinked(d.telegram.botUsername ?? '…')}</p>
                {link && (
                  <div className="panel panel-accent link-box">
                    <p>{t.settings.linkHint}</p>
                    <a className="btn btn-primary btn-sm" href={link.url} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden />{t.settings.openBot}</a>
                  </div>
                )}
                <div className="row-actions">
                  <button type="button" className={`btn btn-sm ${s.telegramLinked ? 'btn-secondary' : 'btn-primary'}`} disabled={makeLink.isPending || !d.telegram.botUsername}
                    onClick={() => makeLink.mutate()}>
                    {s.telegramLinked ? t.settings.linkAgain : t.settings.link}
                  </button>
                  {s.telegramLinked && (
                    <>
                      <button type="button" className="btn btn-ghost btn-sm" disabled={test.isPending} onClick={() => test.mutate()}>{t.settings.test}</button>
                      <button type="button" className="btn btn-ghost btn-sm btn-danger-text" disabled={unlink.isPending} onClick={() => unlink.mutate()}>
                        <Unlink size={14} aria-hidden />{t.settings.unlink}
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </section>

          <section className="panel settings-card">
            <h2>{t.settings.schedule}</h2>
            <div className="settings-grid">
              <div className="field">
                <label htmlFor={ids.tz}>{t.settings.timeZone}</label>
                <select id={ids.tz} className="select" value={s.timeZone} disabled={busy} onChange={(e) => save.mutate({ time_zone: e.target.value })}>
                  {timeZones(s.timeZone).map((z) => <option key={z} value={z}>{z}</option>)}
                </select>
                {browserZone && browserZone !== s.timeZone && (
                  <button type="button" className="btn btn-ghost btn-sm zone-hint" disabled={busy} onClick={() => save.mutate({ time_zone: browserZone })}>
                    {t.settings.useZone(browserZone)}
                  </button>
                )}
              </div>
              <div className="field">
                <label htmlFor={ids.digest}>{t.settings.digestTime}</label>
                <input id={ids.digest} type="time" value={s.digestTime} disabled={busy}
                  onChange={(e) => { if (/^\d\d:\d\d$/.test(e.target.value)) save.mutate({ digest_time: e.target.value }); }} />
              </div>
            </div>
            <div className="field">
              <label htmlFor={ids.remind}>{t.settings.remind}</label>
              <select id={ids.remind} className="select remind-select" value={s.remindEveryHours} disabled={busy}
                onChange={(e) => save.mutate({ remind_every_hours: Number(e.target.value) })}>
                {[...new Set([...REMIND_HOURS, s.remindEveryHours])].sort((a, b) => a - b).map((n) => (
                  <option key={n} value={n}>{n === 0 ? t.settings.remindOff : t.settings.remindEvery(n)}</option>
                ))}
              </select>
              <span className="field-hint">{t.settings.remindHint}</span>
            </div>
            <div className="field">
              <span className="field-label">{t.settings.quiet}</span>
              <div className="quiet-range">
                <label htmlFor={ids.from}>{t.settings.quietFrom}</label>
                <input id={ids.from} type="time" value={s.quietFrom} disabled={busy}
                  onChange={(e) => { if (/^\d\d:\d\d$/.test(e.target.value)) save.mutate({ quiet_from: e.target.value }); }} />
                <label htmlFor={ids.to}>{t.settings.quietTo}</label>
                <input id={ids.to} type="time" value={s.quietTo} disabled={busy}
                  onChange={(e) => { if (/^\d\d:\d\d$/.test(e.target.value)) save.mutate({ quiet_to: e.target.value }); }} />
              </div>
              <span className="field-hint">{t.settings.quietHint}</span>
            </div>
            <fieldset className="checks">
              <legend>{t.settings.notify}</legend>
              <label><input type="checkbox" checked={s.notifyReview} disabled={busy} onChange={(e) => save.mutate({ notify_review: e.target.checked })} />{t.settings.notifyReview}</label>
              <label><input type="checkbox" checked={s.notifyBlocked} disabled={busy} onChange={(e) => save.mutate({ notify_blocked: e.target.checked })} />{t.settings.notifyBlocked}</label>
            </fieldset>
          </section>

          <section className="panel settings-card">
            <h2><Sparkles size={16} aria-hidden />{t.settings.managerTitle}</h2>
            <p className={d.manager.enabled ? '' : 'muted'}>{d.manager.enabled ? t.settings.managerOn(d.manager.model ?? '') : t.settings.managerOff}</p>
            <label className="check">
              <input type="checkbox" checked={s.managerAuto} disabled={busy} onChange={(e) => save.mutate({ manager_auto: e.target.checked })} />
              {t.settings.managerAuto}
            </label>
          </section>
        </div>
      )}
    </div>
  );
}

