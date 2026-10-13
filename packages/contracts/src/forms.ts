/**
 * Form schema + answer validation (spec §17). Same rules as services/api/app/modules/forms/engine.py;
 * both implementations run packages/contracts/fixtures/forms. The server stays authoritative.
 */

export type FieldType =
  | 'text' | 'textarea' | 'integer' | 'decimal' | 'boolean' | 'select' | 'date' | 'photo' | 'equipment_ref';

export type Rule =
  | { field: string; operator: 'equals' | 'not_equals'; value: unknown }
  | { field: string; operator: 'in'; value: unknown[] }
  | { and: Rule[] }
  | { or: Rule[] };

export interface FormField {
  id: string;
  type: FieldType;
  label?: string;
  help?: string;
  placeholder?: string;
  required?: boolean;
  options?: string[];
  option_labels?: Record<string, string>;
  max_length?: number;
  min?: number;
  max?: number;
  max_count?: number;
  visible_when?: Rule;
  required_when?: Rule;
}

export interface FormSchema {
  schema_version: 1;
  key: string;
  version?: number;
  title?: string;
  fields: FormField[];
}

export const FIELD_TYPES: FieldType[] = [
  'text', 'textarea', 'integer', 'decimal', 'boolean', 'select', 'date', 'photo', 'equipment_ref',
];
const OPERATORS = new Set(['equals', 'not_equals', 'in']);
const FIELD_ID = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_FIELDS = 40;
const MAX_RULE_DEPTH = 4;
const MAX_RULE_NODES = 20;
const MAX_OPTIONS = 30;
const MAX_TEXT = 2000;

export const BUSINESS_FIELDS: Record<string, Record<string, { type: FieldType; options: string[] }>> = {
  'return-inspection': { condition: { type: 'select', options: ['GOOD', 'NEEDS_REPAIR', 'UNUSABLE'] } },
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const sameKeys = (o: Record<string, unknown>, keys: string[]) => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => k.includes(x));
};

function ruleErrors(rule: unknown, before: Map<string, FormField>, depth: number, counter: { n: number }): string[] {
  counter.n += 1;
  if (counter.n > MAX_RULE_NODES) return ['rule has too many conditions'];
  if (depth > MAX_RULE_DEPTH) return ['rule nesting is too deep'];
  if (!isObj(rule)) return ['rule must be an object'];
  if (sameKeys(rule, ['and']) || sameKeys(rule, ['or'])) {
    const items = Object.values(rule)[0];
    if (!Array.isArray(items) || items.length < 1 || items.length > 10) return ['and/or must contain 1-10 conditions'];
    return items.flatMap((i) => ruleErrors(i, before, depth + 1, counter));
  }
  if (!sameKeys(rule, ['field', 'operator', 'value'])) return ['condition must have exactly field, operator and value'];
  const { field, operator, value } = rule as { field: unknown; operator: unknown; value: unknown };
  if (typeof operator !== 'string' || !OPERATORS.has(operator)) return [`unsupported operator ${String(operator)}`];
  if (typeof field !== 'string' || !before.has(field)) return [`condition references unknown or later field ${String(field)}`];
  const target = before.get(field)!;
  if (operator === 'in' && (!Array.isArray(value) || value.length === 0 || value.length > MAX_OPTIONS)) {
    return ["'in' requires a non-empty list"];
  }
  const values = operator === 'in' ? (value as unknown[]) : [value];
  for (const v of values) {
    const t = target.type;
    if (t === 'select' && !(target.options ?? []).includes(v as string)) return [`value is not an option of ${field}`];
    if (t === 'boolean' && typeof v !== 'boolean') return [`${field} is boolean`];
    if ((t === 'integer' || t === 'decimal') && !isNum(v)) return [`${field} is numeric`];
    if ((t === 'text' || t === 'textarea' || t === 'date') && typeof v !== 'string') return [`${field} is text`];
    if (t === 'photo' || t === 'equipment_ref') return [`conditions cannot reference ${t} fields`];
  }
  return [];
}

const ALLOWED_FIELD_KEYS = new Set([
  'id', 'type', 'label', 'help', 'required', 'options', 'option_labels', 'max_length', 'min', 'max', 'max_count',
  'visible_when', 'required_when', 'placeholder',
]);

/** Returns {path: message}; empty means publishable. */
export function validateSchema(schema: unknown): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!isObj(schema)) return { _: 'schema must be an object' };
  const allowedTop = new Set(['schema_version', 'key', 'version', 'title', 'fields']);
  for (const k of Object.keys(schema)) if (!allowedTop.has(k)) errors[k] = 'unknown property';
  if (schema.schema_version !== 1) errors.schema_version = 'unsupported schema_version';
  const key = schema.key;
  if (typeof key !== 'string' || !/^[a-z][a-z0-9-]{1,79}$/.test(key)) errors.key = 'invalid key';
  const fields = schema.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    errors.fields = 'at least one field is required';
    return errors;
  }
  if (fields.length > MAX_FIELDS) {
    errors.fields = `at most ${MAX_FIELDS} fields`;
    return errors;
  }
  const seen = new Map<string, FormField>();
  fields.forEach((f: unknown, i: number) => {
    const p = `fields.${i}`;
    if (!isObj(f)) {
      errors[p] = 'field must be an object';
      return;
    }
    for (const k of Object.keys(f)) if (!ALLOWED_FIELD_KEYS.has(k)) errors[`${p}.${k}`] = 'unknown property';
    const fid = f.id;
    if (typeof fid !== 'string' || !FIELD_ID.test(fid)) {
      errors[`${p}.id`] = 'invalid field id';
      return;
    }
    if (seen.has(fid)) {
      errors[`${p}.id`] = 'duplicate field id';
      return;
    }
    const t = f.type;
    if (typeof t !== 'string' || !FIELD_TYPES.includes(t as FieldType)) {
      errors[`${p}.type`] = `unsupported field type ${String(t)}`;
      return;
    }
    if ('label' in f && (typeof f.label !== 'string' || f.label.length > 120)) {
      errors[`${p}.label`] = 'label must be text up to 120 characters';
    }
    if ('required' in f && typeof f.required !== 'boolean') errors[`${p}.required`] = 'required must be boolean';
    if (t === 'select') {
      const opts = f.options;
      const ok =
        Array.isArray(opts) && opts.length >= 1 && opts.length <= MAX_OPTIONS &&
        opts.every((o) => typeof o === 'string' && /^[A-Z0-9_]{1,40}$/.test(o)) && new Set(opts).size === opts.length;
      if (!ok) errors[`${p}.options`] = 'options must be 1-30 unique UPPER_SNAKE codes';
    }
    if ((t === 'text' || t === 'textarea') && 'max_length' in f) {
      const ml = f.max_length;
      if (!isInt(ml) || (ml as number) < 1 || (ml as number) > MAX_TEXT) errors[`${p}.max_length`] = `max_length must be 1-${MAX_TEXT}`;
    }
    if (t === 'photo') {
      const mc = 'max_count' in f ? f.max_count : 1;
      if (!isInt(mc) || (mc as number) < 1 || (mc as number) > 5) errors[`${p}.max_count`] = 'max_count must be 1-5';
    }
    for (const rk of ['visible_when', 'required_when'] as const) {
      if (rk in f) {
        const errs = ruleErrors(f[rk], seen, 1, { n: 0 });
        if (errs.length) errors[`${p}.${rk}`] = errs[0];
      }
    }
    seen.set(fid, f as unknown as FormField);
  });
  const required = BUSINESS_FIELDS[typeof key === 'string' ? key : ''] ?? {};
  for (const [fid, spec] of Object.entries(required)) {
    const f = seen.get(fid);
    if (!f) errors[`fields.${fid}`] = 'business-required field cannot be removed';
    else if (f.type !== spec.type || !f.required) errors[`fields.${fid}`] = 'business-required field must stay a required select';
    else if (f.visible_when) errors[`fields.${fid}`] = 'business-required field cannot be hidden';
    else {
      const a = new Set(f.options ?? []);
      if (a.size !== spec.options.length || !spec.options.every((o) => a.has(o))) {
        errors[`fields.${fid}.options`] = 'business-required options cannot change';
      }
    }
  }
  return errors;
}

export function evalRule(rule: Rule, answers: Record<string, unknown>): boolean {
  if ('and' in rule) return rule.and.every((r) => evalRule(r, answers));
  if ('or' in rule) return rule.or.some((r) => evalRule(r, answers));
  const actual = answers[rule.field];
  switch (rule.operator) {
    case 'equals':
      return actual === rule.value;
    case 'not_equals':
      return actual !== rule.value;
    case 'in':
      return (rule.value as unknown[]).includes(actual);
  }
  return false;
}

/** Visibility is evaluated in order; hidden fields are treated as unanswered for later rules. */
export function visibleFields(schema: FormSchema, answers: Record<string, unknown>): FormField[] {
  const effective: Record<string, unknown> = {};
  const out: FormField[] = [];
  for (const f of schema.fields) {
    if (f.visible_when && !evalRule(f.visible_when, effective)) continue;
    out.push(f);
    if (f.id in answers) effective[f.id] = answers[f.id];
  }
  return out;
}

export function isRequired(field: FormField, answers: Record<string, unknown>): boolean {
  if (field.required) return true;
  if (field.required_when) return evalRule(field.required_when, answers);
  return false;
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

export function validateAnswers(
  schema: FormSchema, answers: Record<string, unknown>, attachmentIds?: Set<string>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const known = new Set(schema.fields.map((f) => f.id));
  for (const k of Object.keys(answers)) if (!known.has(k)) errors[k] = 'unknown field';
  const vis = visibleFields(schema, answers);
  const visIds = new Set(vis.map((f) => f.id));
  for (const k of Object.keys(answers)) if (known.has(k) && !visIds.has(k)) errors[k] = 'answer supplied for a hidden field';
  for (const f of vis) {
    const v = answers[f.id];
    if (isEmpty(v)) {
      if (isRequired(f, answers)) errors[f.id] = 'required';
      continue;
    }
    switch (f.type) {
      case 'text':
      case 'textarea':
        if (typeof v !== 'string') errors[f.id] = 'must be text';
        else if (v.length > (f.max_length ?? MAX_TEXT)) errors[f.id] = 'too long';
        break;
      case 'integer':
        if (!isInt(v)) errors[f.id] = 'must be a whole number';
        break;
      case 'decimal':
        if (!isNum(v)) errors[f.id] = 'must be a number';
        break;
      case 'boolean':
        if (typeof v !== 'boolean') errors[f.id] = 'must be true or false';
        break;
      case 'select':
        if (!(f.options ?? []).includes(v as string)) errors[f.id] = 'not an allowed option';
        break;
      case 'date':
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) errors[f.id] = 'must be an ISO date';
        break;
      case 'photo':
        if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) errors[f.id] = 'must be a list of attachment ids';
        else if (v.length > (f.max_count ?? 1)) errors[f.id] = 'too many photos';
        else if (attachmentIds && !v.every((x) => attachmentIds.has(x))) errors[f.id] = "photo is not one of this submission's attachments";
        break;
      case 'equipment_ref':
        if (typeof v !== 'string') errors[f.id] = 'must be an equipment id';
        break;
    }
  }
  return errors;
}

/** Client removes hidden-field answers before submission (spec §17). */
export function pruneHidden(schema: FormSchema, answers: Record<string, unknown>): Record<string, unknown> {
  const ids = new Set(visibleFields(schema, answers).map((f) => f.id));
  return Object.fromEntries(Object.entries(answers).filter(([k, v]) => ids.has(k) && !isEmpty(v)));
}

export function optionLabel(field: FormField, value: string): string {
  return field.option_labels?.[value] ?? value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');
}
