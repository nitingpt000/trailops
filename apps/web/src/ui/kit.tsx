import { Dropdown, type DropdownProps } from './Dropdown';
import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { CircleAlert, CircleCheck, Info, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import { STATUS_LABEL, type EquipmentStatus, type Tone as StatusTone } from '@trailops/contracts';
import { fieldLabel, type ReceiptView } from '../api/commands';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary',
  pending,
  icon,
  children,
  className,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; pending?: boolean; icon?: ReactNode }) {
  return (
    <button
      type="button"
      {...rest}
      className={`btn btn-${variant} ${className ?? ''}`}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
    >
      {pending ? <LoaderCircle className="spin" size={18} aria-hidden /> : icon}
      <span>{children}</span>
    </button>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="spinner" role="status">
      <LoaderCircle className="spin" size={22} aria-hidden />
      <span>{label}…</span>
    </div>
  );
}

const TONE_ICON = { success: CircleCheck, warning: TriangleAlert, error: CircleAlert, info: Info } as const;

export function Callout({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: 'success' | 'warning' | 'error' | 'info';
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const Icon = TONE_ICON[tone];
  return (
    <div className={`callout callout-${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      <Icon size={20} aria-hidden className="callout-icon" />
      <div className="callout-body">
        {title && <strong>{title}</strong>}
        {children && <div>{children}</div>}
        {action && <div className="callout-action">{action}</div>}
      </div>
    </div>
  );
}

/** Inline receipt outcome for forms: server message plus per-field errors. */
export function ReceiptNotice({ outcome }: { outcome: ReceiptView | null }) {
  if (!outcome || outcome.tone === 'success') return null;
  const fe = Object.entries(outcome.fieldErrors ?? {});
  return (
    <Callout
      tone={outcome.tone}
      title={
        <>
          {outcome.title}
          {outcome.code && <code className="code-chip">{outcome.code}</code>}
        </>
      }
    >
      <p>{outcome.message}</p>
      {fe.length > 0 && (
        <ul className="field-errors">
          {fe.map(([k, v]) => (
            <li key={k}>
              <strong>{fieldLabel(k)}</strong>: {String(v)}
            </li>
          ))}
        </ul>
      )}
      {outcome.refresh && <p className="muted">The latest server state has been reloaded — review it before trying again.</p>}
    </Callout>
  );
}

export function StatusBadge({ status }: { status: EquipmentStatus }) {
  const s = STATUS_LABEL[status];
  return <span className={`badge badge-${s.tone}`}>{s.label}</span>;
}

export function Badge({ tone = 'neutral', children }: { tone?: StatusTone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  required,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  htmlFor: string;
  required?: boolean;
}) {
  return (
    <div className={`field ${error ? 'field-invalid' : ''}`}>
      <label htmlFor={htmlFor}>
        {label}
        {required && <span className="req" aria-hidden> *</span>}
      </label>
      {children}
      {hint && !error && <p className="hint">{hint}</p>}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function TextInput({
  label,
  hint,
  error,
  required,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode; error?: string | null }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={rest.id ?? id} required={required}>
      <input id={rest.id ?? id} className="input" required={required} aria-invalid={!!error || undefined} {...rest} />
    </Field>
  );
}

export function TextArea({
  label,
  hint,
  error,
  required,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: ReactNode; hint?: ReactNode; error?: string | null }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={rest.id ?? id} required={required}>
      <textarea id={rest.id ?? id} className="input" rows={3} required={required} aria-invalid={!!error || undefined} {...rest} />
    </Field>
  );
}

export function Select({
  label,
  hint,
  error,
  required,
  children,
  ...rest
}: Omit<DropdownProps, 'aria-invalid'> & { label: ReactNode; hint?: ReactNode; error?: string | null }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={rest.id ?? id} required={required}>
      <Dropdown id={rest.id ?? id} required={required} aria-invalid={!!error || undefined} emptyIsPlaceholder {...rest}>
        {children}
      </Dropdown>
    </Field>
  );
}

/** Modal dialog on the native <dialog> element: focus is trapped, Escape closes, focus returns. */
export function Dialog({
  title,
  description,
  onClose,
  children,
  footer,
  wide,
  variant = 'modal',
}: {
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  variant?: 'modal' | 'drawer';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const el = ref.current;
    const opener = document.activeElement as HTMLElement | null;
    if (el && !el.open) el.showModal();
    return () => {
      opener?.focus?.();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog dialog-${variant} ${wide ? 'dialog-wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        // Escape that just closed an open dropdown inside this dialog must not close the dialog too.
        const at = Number(ref.current?.dataset.dropdownEscapeAt ?? 0);
        if (Date.now() - at < 250) return;
        closeRef.current();
      }}
      onClick={(e) => {
        if (e.target === ref.current) closeRef.current();
      }}
    >
      <div className="dialog-inner">
        <header className="dialog-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p className="muted">{description}</p>}
          </div>
          <button className="icon-btn" aria-label="Close" onClick={() => closeRef.current()}>
            <X size={20} />
          </button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-footer">{footer}</footer>}
      </div>
    </dialog>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <strong>{title}</strong>
      {children && <p className="muted">{children}</p>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <Callout tone="error" title="Could not load" action={onRetry && <Button onClick={onRetry}>Retry</Button>}>
      {message}
    </Callout>
  );
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

export function Avatar({ name, dark }: { name: string | null | undefined; dark?: boolean }) {
  return (
    <span className={`avatar ${dark ? 'avatar-dark' : ''}`} aria-hidden>
      {initials(name)}
    </span>
  );
}

const dtf = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const tf = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dtf.format(d);
}
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${dtf.format(d)} ${tf.format(d)}`;
}
export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function DateTimeCell({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span className="muted">—</span>;
  const d = new Date(iso);
  return (
    <time dateTime={iso} className="dt-cell">
      <span>{dtf.format(d)}</span>
      <span className="muted">{tf.format(d)}</span>
    </time>
  );
}

export const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8) : '—');
