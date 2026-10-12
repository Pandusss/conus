import { useId } from 'react';
import { Languages } from 'lucide-react';
import { LANGS, LANG_NAMES, useT } from '../i18n';

/**
 * The UI language as a two-button EN | RU control; the choice is remembered in `conus.lang`. `row` lays it out as a
 * sidebar row with an icon and a visible label, otherwise it stands alone (the login card).
 */
export function LangSwitch({ row }: { row?: boolean }) {
  const { t, lang, setLang } = useT();
  const labelId = useId();
  const buttons = (
    <span className="lang-switch">
      {LANGS.map((l) => (
        <button
          key={l} type="button" lang={l} aria-label={LANG_NAMES[l]} title={LANG_NAMES[l]} aria-pressed={lang === l}
          onClick={() => setLang(l)}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </span>
  );
  if (!row) return <div role="group" aria-label={t.lang.label} className="lang-group">{buttons}</div>;
  return (
    <div role="group" aria-labelledby={labelId} className="side-row">
      <Languages size={16} aria-hidden /><span id={labelId}>{t.lang.label}</span>{buttons}
    </div>
  );
}
