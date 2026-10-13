/**
 * Form-editor state machine (spec §17). Every action returns a schema that keeps the editor's
 * structural guarantees:
 *  - rule references always point at *earlier* fields (moves that would break this are refused);
 *  - conditions that become meaningless after a remove / type change / option change are dropped,
 *    and the editor reports which ones;
 *  - business-required fields (e.g. `condition` on return-inspection) cannot be removed, made
 *    optional, retyped, hidden or have their option codes changed.
 * Remaining author errors (bad ids, empty options, ...) are reported by validateSchema and block publish.
 */
import { BUSINESS_FIELDS, validateSchema, type FieldType, type FormField, type FormSchema, type Rule } from '@trailops/contracts';

export interface EditorState {
  schema: FormSchema;
  selectedId: string | null;
  dirty: boolean;
  notice: string | null;
}

export interface OptionRow {
  code: string;
  label: string;
}

export type EditorAction =
  | { type: 'load'; schema: FormSchema }
  | { type: 'select'; id: string | null }
  | { type: 'add'; fieldType: FieldType; label?: string }
  | { type: 'remove'; id: string }
  | { type: 'move'; id: string; to: number }
  | { type: 'update'; id: string; patch: Partial<Omit<FormField, 'id' | 'type' | 'options' | 'option_labels'>> }
  | { type: 'rename'; id: string; newId: string }
  | { type: 'setType'; id: string; fieldType: FieldType }
  | { type: 'setOptions'; id: string; options: OptionRow[] }
  | { type: 'setRule'; id: string; key: 'visible_when' | 'required_when'; rule: Rule | null }
  | { type: 'setTitle'; title: string }
  | { type: 'clearNotice' };

export const TYPE_LABEL: Record<FieldType, string> = {
  text: 'Short text',
  textarea: 'Long text',
  integer: 'Whole number',
  decimal: 'Decimal number',
  boolean: 'Yes / no',
  select: 'Single select',
  date: 'Date',
  photo: 'Photos',
  equipment_ref: 'Equipment tag (read-only)',
};

export function lockedField(key: string, id: string) {
  return BUSINESS_FIELDS[key]?.[id];
}

export function ruleFields(rule: Rule | undefined): string[] {
  if (!rule) return [];
  if ('and' in rule) return rule.and.flatMap(ruleFields);
  if ('or' in rule) return rule.or.flatMap(ruleFields);
  return [rule.field];
}

/** Fields whose conditions reference `id`. */
export function dependents(schema: FormSchema, id: string): FormField[] {
  return schema.fields.filter((f) => ruleFields(f.visible_when).includes(id) || ruleFields(f.required_when).includes(id));
}

/** A move is allowed if every rule still references only earlier fields afterwards. */
export function canMove(schema: FormSchema, from: number, to: number): boolean {
  if (to < 0 || to >= schema.fields.length || from === to) return false;
  const fields = [...schema.fields];
  const [f] = fields.splice(from, 1);
  fields.splice(to, 0, f!);
  return fields.every((field, i) => {
    const earlier = new Set(fields.slice(0, i).map((x) => x.id));
    return [...ruleFields(field.visible_when), ...ruleFields(field.required_when)].every((r) => earlier.has(r));
  });
}

/** Drops conditions that validateSchema reports as invalid; returns the cleaned schema and what was dropped. */
export function pruneRules(schema: FormSchema): { schema: FormSchema; dropped: string[] } {
  const errors = validateSchema(schema);
  const dropped: string[] = [];
  const fields = schema.fields.map((f, i) => {
    let next = f;
    for (const key of ['visible_when', 'required_when'] as const) {
      if (next[key] && errors[`fields.${i}.${key}`]) {
        const { [key]: _removed, ...rest } = next;
        next = rest as FormField;
        dropped.push(`${f.label ?? f.id} (${key === 'visible_when' ? 'show when' : 'required when'})`);
      }
    }
    return next;
  });
  return { schema: { ...schema, fields }, dropped };
}

function uniqueId(schema: FormSchema, base: string): string {
  const ids = new Set(schema.fields.map((f) => f.id));
  const stem = base.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '').slice(0, 30) || 'field';
  if (!ids.has(stem)) return stem;
  for (let n = 2; ; n++) if (!ids.has(`${stem}_${n}`)) return `${stem}_${n}`;
}

export function toCode(label: string): string {
  return label
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function defaultsFor(t: FieldType): Partial<FormField> {
  switch (t) {
    case 'select':
      return { options: ['OPTION_1', 'OPTION_2'], option_labels: { OPTION_1: 'Option 1', OPTION_2: 'Option 2' } };
    case 'text':
      return { max_length: 120 };
    case 'textarea':
      return { max_length: 500 };
    case 'photo':
      return { max_count: 3 };
    default:
      return {};
  }
}

const TYPE_KEYS: Record<string, FieldType[]> = {
  options: ['select'],
  option_labels: ['select'],
  max_length: ['text', 'textarea'],
  max_count: ['photo'],
  min: ['integer', 'decimal'],
  max: ['integer', 'decimal'],
  placeholder: ['text', 'textarea', 'integer', 'decimal'],
};

function withFields(state: EditorState, fields: FormField[], extra: Partial<EditorState> = {}): EditorState {
  const { schema, dropped } = pruneRules({ ...state.schema, fields });
  return {
    ...state,
    ...extra,
    schema,
    dirty: true,
    notice: dropped.length ? `Removed conditions that no longer apply: ${dropped.join(', ')}.` : (extra.notice ?? null),
  };
}

export function initEditor(schema: FormSchema): EditorState {
  return { schema, selectedId: schema.fields[0]?.id ?? null, dirty: false, notice: null };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  const { schema } = state;
  const idx = (id: string) => schema.fields.findIndex((f) => f.id === id);
  switch (action.type) {
    case 'load':
      return initEditor(action.schema);
    case 'select':
      return { ...state, selectedId: action.id, notice: null };
    case 'clearNotice':
      return { ...state, notice: null };
    case 'setTitle':
      return { ...state, schema: { ...schema, title: action.title }, dirty: true };
    case 'add': {
      const label = action.label ?? 'New field';
      const id = uniqueId(schema, label === 'New field' ? `${action.fieldType}_field` : label);
      const field: FormField = { id, type: action.fieldType, label, ...defaultsFor(action.fieldType) };
      return withFields(state, [...schema.fields, field], { selectedId: id });
    }
    case 'remove': {
      if (lockedField(schema.key, action.id)) {
        return { ...state, notice: 'This business field is required by the workflow and cannot be removed.' };
      }
      const i = idx(action.id);
      if (i < 0) return state;
      const fields = schema.fields.filter((f) => f.id !== action.id);
      const selectedId = state.selectedId === action.id ? (fields[Math.min(i, fields.length - 1)]?.id ?? null) : state.selectedId;
      return withFields(state, fields, { selectedId });
    }
    case 'move': {
      const from = idx(action.id);
      if (from < 0) return state;
      if (!canMove(schema, from, action.to)) {
        return {
          ...state,
          notice:
            action.to < 0 || action.to >= schema.fields.length
              ? null
              : 'That move would put a condition before the field it depends on. Change the condition first.',
        };
      }
      const fields = [...schema.fields];
      const [f] = fields.splice(from, 1);
      fields.splice(action.to, 0, f!);
      return { ...state, schema: { ...schema, fields }, dirty: true, notice: null };
    }
    case 'update': {
      const locked = lockedField(schema.key, action.id);
      const patch = { ...action.patch };
      if (locked) {
        delete patch.visible_when;
        if (patch.required === false) delete patch.required;
      }
      const fields = schema.fields.map((f) => {
        if (f.id !== action.id) return f;
        const next: FormField = { ...f, ...patch };
        for (const [k, v] of Object.entries(patch)) if (v === undefined || v === '') delete (next as unknown as Record<string, unknown>)[k];
        return next;
      });
      return withFields(state, fields);
    }
    case 'rename': {
      if (lockedField(schema.key, action.id) || action.id === action.newId) return state;
      const rename = (r: Rule | undefined): Rule | undefined => {
        if (!r) return r;
        if ('and' in r) return { and: r.and.map((x) => rename(x)!) };
        if ('or' in r) return { or: r.or.map((x) => rename(x)!) };
        return r.field === action.id ? { ...r, field: action.newId } : r;
      };
      const fields = schema.fields.map((f) => {
        const next = { ...f, id: f.id === action.id ? action.newId : f.id };
        if (f.visible_when) next.visible_when = rename(f.visible_when);
        if (f.required_when) next.required_when = rename(f.required_when);
        return next;
      });
      return { ...state, schema: { ...schema, fields }, selectedId: state.selectedId === action.id ? action.newId : state.selectedId, dirty: true };
    }
    case 'setType': {
      if (lockedField(schema.key, action.id)) return { ...state, notice: 'The type of a business field cannot change.' };
      const fields = schema.fields.map((f) => {
        if (f.id !== action.id || f.type === action.fieldType) return f;
        const next: Record<string, unknown> = { ...f, type: action.fieldType };
        for (const [k, types] of Object.entries(TYPE_KEYS)) if (!types.includes(action.fieldType)) delete next[k];
        return { ...defaultsFor(action.fieldType), ...(next as unknown as FormField) };
      });
      return withFields(state, fields);
    }
    case 'setOptions': {
      const locked = lockedField(schema.key, action.id);
      const fields = schema.fields.map((f) => {
        if (f.id !== action.id) return f;
        let rows = action.options;
        if (locked) {
          // Codes are fixed; only labels may change.
          const byCode = new Map(rows.map((r) => [r.code, r.label]));
          rows = locked.options.map((code) => ({ code, label: byCode.get(code) ?? f.option_labels?.[code] ?? code }));
        }
        const option_labels: Record<string, string> = {};
        for (const r of rows) if (r.label.trim()) option_labels[r.code] = r.label;
        return { ...f, options: rows.map((r) => r.code), option_labels };
      });
      return withFields(state, fields);
    }
    case 'setRule': {
      if (action.key === 'visible_when' && lockedField(schema.key, action.id)) {
        return { ...state, notice: 'Business fields are always shown.' };
      }
      const fields = schema.fields.map((f) => {
        if (f.id !== action.id) return f;
        const next = { ...f };
        if (action.rule) next[action.key] = action.rule;
        else delete next[action.key];
        return next;
      });
      return withFields(state, fields);
    }
  }
}

/** Fields a condition on `id` may reference: earlier select / boolean fields. */
export function conditionSources(schema: FormSchema, id: string): FormField[] {
  const i = schema.fields.findIndex((f) => f.id === id);
  return schema.fields.slice(0, Math.max(i, 0)).filter((f) => f.type === 'select' || f.type === 'boolean');
}
