import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { HttpError } from '../api';
import { useT, type Messages } from '../i18n';

/** Error codes of the server's JSON error envelope that have their own text. */
const KNOWN_CODES = ['validation', 'not_found', 'conflict_version', 'invalid_transition', 'unauthorized', 'forbidden', 'rate_limited', 'internal_error'] as const;
type KnownCode = typeof KNOWN_CODES[number];
const isKnown = (code: string): code is KnownCode => (KNOWN_CODES as readonly string[]).includes(code);

/** Human-readable text, in the UI language, for anything a query or mutation can throw. */
export function errorText(e: unknown, t: Messages): string {
  if (e instanceof HttpError) {
    if (isKnown(e.code)) return t.errors[e.code];
    if (e.code === 'error') { // the body was not our JSON error envelope (proxy page, misrouted request)
      if (e.status >= 500) return t.errors.serverStatus(e.status);
      if (e.status === 404) return t.errors.not_found;
      if (e.status < 400) return t.errors.unexpected;
      return t.errors.httpStatus(e.status); // the status text is the proxy's English, not ours
    }
    return e.message || t.errors.httpStatus(e.status); // a code this UI does not know yet: the server's own words
  }
  if (e instanceof TypeError) return t.errors.offline;
  return t.errors.unknown;
}

/** A visible error line for a failed query or action. A 401 sends the user back to the login form. */
export function ErrorLine({ error, prefix }: { error: unknown; prefix?: string }) {
  const qc = useQueryClient();
  const { t } = useT();
  const unauthorized = error instanceof HttpError && error.status === 401;
  useEffect(() => {
    if (unauthorized) void qc.invalidateQueries({ queryKey: ['me'] });
  }, [unauthorized, qc]);
  if (!error) return null;
  return (
    <p className="error" role="alert">
      <CircleAlert size={16} aria-hidden />
      <span>{prefix ? `${prefix}: ` : ''}{errorText(error, t)}</span>
    </p>
  );
}

/**
 * The last failed action of a page with several mutations. Spread `track` into every `useMutation` of the page:
 * the message is cleared when any action starts (so it never outlives the attempt it belongs to) and set when one fails.
 */
export function useActionError() {
  const [error, setError] = useState<unknown>(null);
  return { error, track: { onMutate: () => setError(null), onError: (e: unknown) => setError(e) } };
}
