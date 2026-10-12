import { useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useT } from '../i18n';
import { trapTab, useEscapeLayer, useFocusInside } from './layers';

interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children?: ReactNode;
  /** Buttons at the bottom. With `onSubmit` the body and footer form one <form>, so Enter submits. */
  footer?: ReactNode;
  onSubmit?: () => void;
  className?: string;
}

/**
 * An accessible modal: focus moves into it and comes back afterwards, Tab stays inside, Esc and a click on the
 * overlay close it. Mark the element that should get focus first with `data-autofocus`.
 */
export function Dialog(props: DialogProps) {
  if (!props.open) return null;
  return createPortal(<DialogPanel {...props} />, document.body);
}

function DialogPanel({ title, onClose, children, footer, onSubmit, className }: DialogProps) {
  const { t } = useT();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEscapeLayer(onClose);
  useFocusInside(ref);
  const inner = (
    <>
      <div className="dialog-body">{children}</div>
      {footer && <div className="dialog-foot">{footer}</div>}
    </>
  );
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={ref} className={`dialog${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}
        tabIndex={-1} onKeyDown={(e) => trapTab(e, ref.current)}
      >
        <div className="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" aria-label={t.common.close} onClick={onClose}><X size={18} aria-hidden /></button>
        </div>
        {onSubmit ? <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>{inner}</form> : inner}
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, title, message, confirmLabel, danger, busy, onConfirm, onCancel }: {
  open: boolean; title: string; message?: ReactNode; confirmLabel?: string; danger?: boolean; busy?: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  const { t } = useT();
  return (
    <Dialog
      open={open} title={title} onClose={onCancel} onSubmit={() => { if (!busy) onConfirm(); }} className="dialog-sm"
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel} data-autofocus={danger || undefined}>{t.common.cancel}</button>
          <button type="submit" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy} data-autofocus={!danger || undefined}>{confirmLabel ?? t.common.confirm}</button>
        </>
      )}
    >
      {message && <div className="dialog-text">{message}</div>}
    </Dialog>
  );
}

/** Asks for a reason before an action; `onConfirm` gets the trimmed text, or undefined when it is empty (and optional). */
export function ReasonDialog(props: {
  open: boolean; title: string; label?: string; required?: boolean; confirmLabel?: string; danger?: boolean; busy?: boolean;
  message?: ReactNode; onConfirm: (reason: string | undefined) => void; onCancel: () => void;
}) {
  // Mounted only while open, so every opening starts with an empty field.
  return props.open ? <ReasonForm {...props} /> : null;
}

function ReasonForm({ title, label, required, confirmLabel, danger, busy, message, onConfirm, onCancel }: Parameters<typeof ReasonDialog>[0]) {
  const { t } = useT();
  const [text, setText] = useState('');
  const fieldId = useId();
  const reason = text.trim();
  const blocked = busy || (required && !reason);
  return (
    <Dialog
      open title={title} onClose={onCancel} onSubmit={() => { if (!blocked) onConfirm(reason || undefined); }}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>{t.common.cancel}</button>
          <button type="submit" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={blocked}>{confirmLabel ?? t.common.confirm}</button>
        </>
      )}
    >
      {message && <div className="dialog-text">{message}</div>}
      <div className="field">
        <label htmlFor={fieldId}>{label ?? t.common.reason}{!required && <span className="field-hint">{t.common.optionalHint}</span>}</label>
        <textarea
          id={fieldId} rows={3} value={text} maxLength={900} required={required} data-autofocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl/Cmd+Enter submits from the textarea (plain Enter is a newline)
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !blocked) { e.preventDefault(); onConfirm(reason || undefined); }
          }}
        />
      </div>
    </Dialog>
  );
}

/** A one-line text prompt (rename). `onConfirm` gets the trimmed value; an empty value cannot be confirmed. */
export function PromptDialog(props: {
  open: boolean; title: string; label: string; initial?: string; confirmLabel?: string; busy?: boolean;
  onConfirm: (value: string) => void; onCancel: () => void;
}) {
  return props.open ? <PromptForm {...props} /> : null;
}

function PromptForm({ title, label, initial = '', confirmLabel, busy, onConfirm, onCancel }: Parameters<typeof PromptDialog>[0]) {
  const { t } = useT();
  const [value, setValue] = useState(initial);
  const fieldId = useId();
  const v = value.trim();
  return (
    <Dialog
      open title={title} onClose={onCancel} onSubmit={() => { if (v && !busy) onConfirm(v); }} className="dialog-sm"
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>{t.common.cancel}</button>
          <button type="submit" className="btn btn-primary" disabled={!v || busy}>{confirmLabel ?? t.common.save}</button>
        </>
      )}
    >
      <div className="field">
        <label htmlFor={fieldId}>{label}</label>
        <input id={fieldId} value={value} maxLength={100} data-autofocus onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.target.select()} />
      </div>
    </Dialog>
  );
}
