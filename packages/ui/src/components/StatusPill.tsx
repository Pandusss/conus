import type { Status } from '../api';
import { useT } from '../i18n';

/** The status colour dot; the same colours everywhere (see the --st-* tokens). */
export function StatusDot({ status }: { status: Status }) {
  return <span className={`dot st-${status}`} aria-hidden="true" />;
}

export function StatusPill({ status }: { status: Status }) {
  const { t } = useT();
  return <span className={`pill st-${status}`}><StatusDot status={status} />{t.status[status]}</span>;
}
