import { Dropdown } from '../../ui/Dropdown';
import { useEffect, useId, useState, type Dispatch } from 'react';
import { ArrowDown, ArrowUp, Lock, Plus, X } from 'lucide-react';
import { FIELD_TYPES, optionLabel, type FormField, type FormSchema, type Rule } from '@trailops/contracts';
import { conditionSources, lockedField, toCode, TYPE_LABEL, type EditorAction, type OptionRow } from './editorReducer';
import { Button, Callout, Select, TextInput } from '../../ui/kit';

function Toggle({ checked, onChange, disabled, label, id }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string; id: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}

function ConditionBuilder({
  title,
  verb,
  schema,
  field,
  rule,
  onChange,
}: {
  title: string;
  verb: string;
  schema: FormSchema;
  field: FormField;
  rule: Rule | undefined;
  onChange: (r: Rule | null) => void;
}) {
  const sources = conditionSources(schema, field.id);
  const uid = useId();
  if (rule && ('and' in rule || 'or' in rule)) {
    return (
      <div className="cond">
        <p className="small">{title}: combined rule</p>
        <code className="rule-json">{JSON.stringify(rule)}</code>
        <Button className="btn-sm" onClick={() => onChange(null)}>Remove condition</Button>
      </div>
    );
  }
  const simple = rule as Extract<Rule, { field: string }> | undefined;
  const src = sources.find((s) => s.id === simple?.field);
  const values = (s: FormField | undefined): { v: unknown; label: string }[] =>
    s?.type === 'boolean' ? [{ v: true, label: 'Yes' }, { v: false, label: 'No' }] : (s?.options ?? []).map((o) => ({ v: o, label: optionLabel(s!, o) }));
  const start = (srcId: string) => {
    const s = sources.find((x) => x.id === srcId);
    if (!s) return onChange(null);
    const first = values(s)[0];
    onChange({ field: s.id, operator: 'equals', value: first?.v ?? null });
  };
  return (
    <div className="cond">
      <p className="small cond-title">
        {verb} <strong>{field.label || field.id}</strong> when
      </p>
      {sources.length === 0 ? (
        <p className="muted small">Add a select or yes/no field above this one to build a condition.</p>
      ) : (
        <div className="cond-row">
          <label className="sr-only" htmlFor={`${uid}-f`}>Condition field</label>
          <Dropdown id={`${uid}-f`} value={simple?.field ?? ''} onChange={(e) => start(e.target.value)}>
            <option value="">Always</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label || s.id}
              </option>
            ))}
          </Dropdown>
          {simple && src && (
            <>
              <label className="sr-only" htmlFor={`${uid}-o`}>Operator</label>
              <Dropdown
                id={`${uid}-o`}
                className="cond-op"
                value={simple.operator}
                onChange={(e) => {
                  const op = e.target.value as 'equals' | 'not_equals' | 'in';
                  const first = values(src)[0]?.v ?? null;
                  if (op === 'in') onChange({ field: simple.field, operator: 'in', value: Array.isArray(simple.value) ? simple.value : [simple.value ?? first] });
                  else onChange({ field: simple.field, operator: op, value: Array.isArray(simple.value) ? simple.value[0] : simple.value });
                }}
              >
                <option value="equals">is</option>
                <option value="not_equals">is not</option>
                {src.type === 'select' && <option value="in">is one of</option>}
              </Dropdown>
              {simple.operator === 'in' ? (
                <fieldset className="cond-multi">
                  <legend className="sr-only">Values</legend>
                  {values(src).map(({ v, label }) => {
                    const arr = (simple.value as unknown[]) ?? [];
                    const on = arr.includes(v);
                    return (
                      <label key={String(v)} className="check">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => {
                            const next = on ? arr.filter((x) => x !== v) : [...arr, v];
                            if (next.length) onChange({ field: simple.field, operator: 'in', value: next });
                          }}
                        />
                        {label}
                      </label>
                    );
                  })}
                </fieldset>
              ) : (
                <>
                  <label className="sr-only" htmlFor={`${uid}-v`}>Value</label>
                  <Dropdown
                    id={`${uid}-v`}
                    
                    value={String(simple.value)}
                    onChange={(e) => {
                      const picked = values(src).find((x) => String(x.v) === e.target.value);
                      onChange({ field: simple.field, operator: simple.operator, value: picked?.v ?? e.target.value } as Rule);
                    }}
                  >
                    {values(src).map(({ v, label }) => (
                      <option key={String(v)} value={String(v)}>
                        {label}
                      </option>
                    ))}
                  </Dropdown>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function OptionsEditor({ field, locked, dispatch }: { field: FormField; locked: boolean; dispatch: Dispatch<EditorAction> }) {
  const rows: OptionRow[] = (field.options ?? []).map((code) => ({ code, label: field.option_labels?.[code] ?? '' }));
  const set = (next: OptionRow[]) => dispatch({ type: 'setOptions', id: field.id, options: next });
  return (
    <fieldset className="options">
      <legend>Options</legend>
      {locked && (
        <p className="muted small">
          <Lock size={14} aria-hidden /> Option codes are fixed by the workflow; labels can change.
        </p>
      )}
      <ul>
        {rows.map((r, i) => (
          <li key={i} className="option-row">
            <div className="option-move">
              <button className="icon-btn sm" aria-label={`Move ${r.code} up`} disabled={i === 0 || locked} onClick={() => { const n = [...rows]; [n[i - 1], n[i]] = [n[i]!, n[i - 1]!]; set(n); }}>
                <ArrowUp size={14} />
              </button>
              <button className="icon-btn sm" aria-label={`Move ${r.code} down`} disabled={i === rows.length - 1 || locked} onClick={() => { const n = [...rows]; [n[i + 1], n[i]] = [n[i]!, n[i + 1]!]; set(n); }}>
                <ArrowDown size={14} />
              </button>
            </div>
            <input
              className="input"
              aria-label={`Label for option ${i + 1}`}
              value={r.label}
              placeholder="Label"
              maxLength={80}
              onChange={(e) => {
                const n = [...rows];
                const autoCode = !locked && (r.code === toCode(r.label) || /^OPTION_\d+$/.test(r.code));
                n[i] = { label: e.target.value, code: autoCode && toCode(e.target.value) ? toCode(e.target.value) : r.code };
                set(n);
              }}
            />
            <input
              className="input code-input"
              aria-label={`Code for option ${i + 1}`}
              value={r.code}
              disabled={locked}
              maxLength={40}
              onChange={(e) => {
                const n = [...rows];
                n[i] = { ...r, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') };
                set(n);
              }}
            />
            <button className="icon-btn" aria-label={`Remove option ${r.label || r.code}`} disabled={locked || rows.length <= 1} onClick={() => set(rows.filter((_, j) => j !== i))}>
              <X size={18} />
            </button>
          </li>
        ))}
      </ul>
      {!locked && (
        <Button
          className="btn-sm"
          icon={<Plus size={16} aria-hidden />}
          onClick={() => {
            let n = rows.length + 1;
            while (rows.some((r) => r.code === `OPTION_${n}`)) n++;
            set([...rows, { code: `OPTION_${n}`, label: `Option ${n}` }]);
          }}
        >
          Add option
        </Button>
      )}
    </fieldset>
  );
}

export function FieldConfig({
  schema,
  field,
  errors,
  publishedIds,
  readOnly,
  dispatch,
}: {
  schema: FormSchema;
  field: FormField | undefined;
  errors: Record<string, string>;
  publishedIds: Set<string>;
  readOnly: boolean;
  dispatch: Dispatch<EditorAction>;
}) {
  const uid = useId();
  const [idDraft, setIdDraft] = useState(field?.id ?? '');
  useEffect(() => setIdDraft(field?.id ?? ''), [field?.id]);
  if (!field) return <p className="muted">Select a field to configure it.</p>;
  const locked = !!lockedField(schema.key, field.id);
  const index = schema.fields.indexOf(field);
  const fieldErrors = Object.entries(errors).filter(([k]) => k.startsWith(`fields.${index}.`) || k === `fields.${index}` || k === `fields.${field.id}` || k.startsWith(`fields.${field.id}.`));
  const update = (patch: Extract<EditorAction, { type: 'update' }>['patch']) => dispatch({ type: 'update', id: field.id, patch });

  return (
    <fieldset className="config" disabled={readOnly}>
      <legend className="sr-only">Configure {field.label || field.id}</legend>
      {locked && (
        <Callout tone="info" title="Business field">
          The workflow depends on this field. It cannot be removed, hidden, made optional or retyped.
        </Callout>
      )}
      <div className="config-row">
        <label htmlFor={`${uid}-type`}>Field type</label>
        <Dropdown id={`${uid}-type`} value={field.type} disabled={locked} onChange={(e) => dispatch({ type: 'setType', id: field.id, fieldType: e.target.value as FormField['type'] })}>
          {FIELD_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </Dropdown>
      </div>
      <div className="config-row">
        <label htmlFor={`${uid}-label`}>Field label</label>
        <input id={`${uid}-label`} className="input" value={field.label ?? ''} maxLength={120} onChange={(e) => update({ label: e.target.value })} />
      </div>
      <div className="config-row">
        <label htmlFor={`${uid}-id`}>Field id</label>
        <div>
          <input
            id={`${uid}-id`}
            className="input code-input"
            value={idDraft}
            disabled={locked || publishedIds.has(field.id)}
            maxLength={40}
            onChange={(e) => setIdDraft(e.target.value.toLowerCase())}
            onBlur={() => {
              if (idDraft && idDraft !== field.id && /^[a-z][a-z0-9_]{0,39}$/.test(idDraft) && !schema.fields.some((f) => f.id === idDraft)) {
                dispatch({ type: 'rename', id: field.id, newId: idDraft });
              } else setIdDraft(field.id);
            }}
          />
          <p className="hint">{publishedIds.has(field.id) ? 'Stable id from a published version — answers are stored under it.' : 'lower_snake id; stays stable when the label changes.'}</p>
        </div>
      </div>
      <div className="config-row">
        <label htmlFor={`${uid}-req`}>Required field</label>
        <div>
          <Toggle id={`${uid}-req`} label="Required field" checked={!!field.required} disabled={locked} onChange={(v) => update({ required: v ? true : undefined })} />
          <p className="hint">{field.required ? 'Must be answered whenever it is shown.' : field.required_when ? 'Required only when its condition below matches.' : 'Optional.'}</p>
        </div>
      </div>
      <div className="config-row">
        <label htmlFor={`${uid}-help`}>Help text</label>
        <input id={`${uid}-help`} className="input" value={field.help ?? ''} maxLength={200} onChange={(e) => update({ help: e.target.value || undefined })} />
      </div>
      {field.type === 'select' && <OptionsEditor field={field} locked={locked} dispatch={dispatch} />}
      {(field.type === 'text' || field.type === 'textarea') && (
        <TextInput label="Maximum length" type="number" min={1} max={2000} value={field.max_length ?? ''} onChange={(e) => update({ max_length: e.target.value ? Number(e.target.value) : undefined })} />
      )}
      {field.type === 'photo' && (
        <TextInput label="Maximum photos" type="number" min={1} max={5} value={field.max_count ?? ''} onChange={(e) => update({ max_count: e.target.value ? Number(e.target.value) : undefined })} hint="1–5. The return policy also caps photos at 3." />
      )}
      {field.type === 'equipment_ref' && <p className="muted small">Filled from the scanned item on mobile; not editable by the operator.</p>}

      <div className="config-section">
        <h3>Conditional logic</h3>
        <p className="muted small">Show or hide fields based on earlier answers. Hidden answers are discarded before submission.</p>
        {locked ? (
          <p className="small">Always shown.</p>
        ) : (
          <ConditionBuilder title="Show" verb="Show" schema={schema} field={field} rule={field.visible_when} onChange={(r) => dispatch({ type: 'setRule', id: field.id, key: 'visible_when', rule: r })} />
        )}
        {!field.required && (
          <ConditionBuilder title="Required" verb="Require" schema={schema} field={field} rule={field.required_when} onChange={(r) => dispatch({ type: 'setRule', id: field.id, key: 'required_when', rule: r })} />
        )}
      </div>
      {fieldErrors.length > 0 && (
        <Callout tone="error" title="Fix before publishing">
          <ul className="field-errors">
            {fieldErrors.map(([k, v]) => (
              <li key={k}>
                <code>{k.split('.').slice(2).join('.') || 'field'}</code>: {v}
              </li>
            ))}
          </ul>
        </Callout>
      )}
      <Select label="Position" value={String(index)} onChange={(e) => dispatch({ type: 'move', id: field.id, to: Number(e.target.value) })} hint="Conditions must refer to earlier fields.">
        {schema.fields.map((_, i) => (
          <option key={i} value={i}>
            {i + 1}
          </option>
        ))}
      </Select>
    </fieldset>
  );
}
