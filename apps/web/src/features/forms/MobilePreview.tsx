import { Dropdown } from '../../ui/Dropdown';
import { useMemo, useState } from 'react';
import { Barcode, ImagePlus, RotateCcw } from 'lucide-react';
import { isRequired, optionLabel, validateAnswers, visibleFields, type FormField, type FormSchema } from '@trailops/contracts';
import { Button } from '../../ui/kit';

/**
 * Interactive mobile preview rendered from the schema with the shared form engine, so conditional
 * logic can be tried. A visual preview does not prove the mobile renderer matches (spec §17).
 */
export function MobilePreview({ schema, selectedId, onSelect }: { schema: FormSchema; selectedId: string | null; onSelect: (id: string) => void }) {
  const [raw, setAnswers] = useState<Record<string, unknown>>({});
  const [checked, setChecked] = useState(false);
  // Equipment references are system-filled from the selected item on mobile.
  const answers = useMemo(() => {
    const a = { ...raw };
    for (const f of schema.fields) if (f.type === 'equipment_ref') a[f.id] = 'preview-item';
    return a;
  }, [raw, schema.fields]);
  const visible = visibleFields(schema, answers);
  // Hidden answers are ignored like the client removes them before submission.
  const effective = useMemo(() => {
    const ids = new Set(visible.map((f) => f.id));
    return Object.fromEntries(Object.entries(answers).filter(([k, v]) => ids.has(k) && v !== '' && v !== undefined));
  }, [answers, visible]);
  const errors = checked ? validateAnswers(schema, effective) : {};
  const set = (id: string, v: unknown) => setAnswers((a) => ({ ...a, [id]: v }));

  const render = (f: FormField, n: number) => {
    const id = `pv-${f.id}`;
    const req = isRequired(f, effective);
    const label = (
      <span className="pv-label">
        {n}. {f.label || f.id}
        {req && <span className="req"> *</span>}
      </span>
    );
    const v = answers[f.id];
    let control: JSX.Element;
    switch (f.type) {
      case 'select':
        control =
          (f.options?.length ?? 0) <= 4 ? (
            <div role="radiogroup" aria-labelledby={`${id}-l`} className="pv-radios">
              {(f.options ?? []).map((o) => (
                <label key={o} className={`pv-radio ${v === o ? 'checked' : ''}`}>
                  <input type="radio" name={id} checked={v === o} onChange={() => set(f.id, o)} />
                  {optionLabel(f, o)}
                </label>
              ))}
            </div>
          ) : (
            <Dropdown id={id} emptyIsPlaceholder value={(v as string) ?? ''} onChange={(e) => set(f.id, e.target.value || undefined)}>
              <option value="">Select…</option>
              {(f.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {optionLabel(f, o)}
                </option>
              ))}
            </Dropdown>
          );
        break;
      case 'boolean':
        control = (
          <div className="pv-radios pv-inline">
            {[true, false].map((b) => (
              <label key={String(b)} className={`pv-radio ${v === b ? 'checked' : ''}`}>
                <input type="radio" name={id} checked={v === b} onChange={() => set(f.id, b)} />
                {b ? 'Yes' : 'No'}
              </label>
            ))}
          </div>
        );
        break;
      case 'textarea':
        control = <textarea id={id} className="input" rows={3} maxLength={f.max_length} placeholder={f.placeholder} value={(v as string) ?? ''} onChange={(e) => set(f.id, e.target.value)} />;
        break;
      case 'integer':
      case 'decimal':
        control = (
          <input
            id={id}
            className="input"
            type="number"
            step={f.type === 'integer' ? 1 : 'any'}
            value={v === undefined ? '' : String(v)}
            onChange={(e) => set(f.id, e.target.value === '' ? undefined : Number(e.target.value))}
          />
        );
        break;
      case 'date':
        control = <input id={id} className="input" type="date" value={(v as string) ?? ''} onChange={(e) => set(f.id, e.target.value)} />;
        break;
      case 'photo': {
        const photos = (v as string[] | undefined) ?? [];
        control = (
          <button
            type="button"
            className="pv-photo"
            onClick={() => set(f.id, photos.length >= (f.max_count ?? 1) ? [] : [...photos, `preview-photo-${photos.length + 1}`])}
          >
            <ImagePlus size={24} aria-hidden />
            <span>{photos.length ? `${photos.length} photo${photos.length > 1 ? 's' : ''} added (tap to ${photos.length >= (f.max_count ?? 1) ? 'clear' : 'add'})` : 'Add photos'}</span>
            <span className="muted small">Up to {f.max_count ?? 1}. Preview only — no upload.</span>
          </button>
        );
        break;
      }
      case 'equipment_ref':
        control = (
          <div className="input pv-readonly">
            <Barcode size={18} aria-hidden /> JKT-021
          </div>
        );
        break;
      default:
        control = <input id={id} className="input" maxLength={f.max_length} placeholder={f.placeholder} value={(v as string) ?? ''} onChange={(e) => set(f.id, e.target.value)} />;
    }
    return (
      <div key={f.id} className={`pv-field ${selectedId === f.id ? 'pv-selected' : ''}`} onClickCapture={() => onSelect(f.id)}>
        <label htmlFor={id} id={`${id}-l`}>
          {label}
        </label>
        {f.help && <p className="muted small">{f.help}</p>}
        {control}
        {errors[f.id] && <p className="error-text">{errors[f.id]}</p>}
      </div>
    );
  };

  return (
    <div className="phone" aria-label="Mobile preview">
      <div className="phone-screen">
        <h3 className="pv-title">{schema.title || 'Form'}</h3>
        <p className="muted small">Indiahikes</p>
        {visible.map((f, i) => render(f, i + 1))}
        <div className="pv-actions">
          <Button className="btn-sm" onClick={() => setChecked(true)}>
            Check answers
          </Button>
          <Button
            className="btn-sm"
            variant="ghost"
            icon={<RotateCcw size={16} aria-hidden />}
            onClick={() => {
              setAnswers({});
              setChecked(false);
            }}
          >
            Reset
          </Button>
        </div>
        {checked && Object.keys(errors).length === 0 && <p className="ok-text small">Answers are valid for this schema.</p>}
      </div>
    </div>
  );
}
