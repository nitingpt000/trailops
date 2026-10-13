import { describe, expect, it } from 'vitest';
import { validateSchema, visibleFields, type FormSchema } from '@trailops/contracts';
import { canMove, editorReducer, initEditor, type EditorState } from './editorReducer';

/** Same shape as the seeded return-inspection v3. */
const V3: FormSchema = {
  schema_version: 1,
  key: 'return-inspection',
  version: 3,
  title: 'Return inspection',
  fields: [
    { id: 'equipment', type: 'equipment_ref', label: 'Equipment tag', required: true },
    {
      id: 'condition',
      type: 'select',
      label: 'Condition',
      required: true,
      options: ['GOOD', 'NEEDS_REPAIR', 'UNUSABLE'],
      option_labels: { GOOD: 'Good', NEEDS_REPAIR: 'Needs repair', UNUSABLE: 'Unusable' },
    },
    {
      id: 'issue_type',
      type: 'select',
      label: 'Issue type',
      required: true,
      options: ['BROKEN_ZIP', 'TEAR', 'OTHER'],
      visible_when: { field: 'condition', operator: 'in', value: ['NEEDS_REPAIR', 'UNUSABLE'] },
    },
    {
      id: 'photos',
      type: 'photo',
      label: 'Photos',
      max_count: 3,
      required_when: { field: 'condition', operator: 'equals', value: 'NEEDS_REPAIR' },
    },
    { id: 'notes', type: 'textarea', label: 'Notes', max_length: 500 },
  ],
};

const run = (s: EditorState, ...actions: Parameters<typeof editorReducer>[1][]) => actions.reduce(editorReducer, s);
const ids = (s: EditorState) => s.schema.fields.map((f) => f.id);

describe('form editor reducer', () => {
  it('starts from a valid published schema', () => {
    expect(validateSchema(V3)).toEqual({});
  });

  it('adds a field with a unique id and keeps the schema valid', () => {
    const s = run(initEditor(V3), { type: 'add', fieldType: 'boolean', label: 'Washed' }, { type: 'add', fieldType: 'select' }, { type: 'add', fieldType: 'select' });
    expect(ids(s)).toEqual(['equipment', 'condition', 'issue_type', 'photos', 'notes', 'washed', 'select_field', 'select_field_2']);
    expect(s.selectedId).toBe('select_field_2');
    expect(s.dirty).toBe(true);
    expect(validateSchema(s.schema)).toEqual({});
  });

  it('reorders fields with up/down moves', () => {
    const s = run(initEditor(V3), { type: 'move', id: 'notes', to: 3 });
    expect(ids(s)).toEqual(['equipment', 'condition', 'issue_type', 'notes', 'photos']);
    expect(validateSchema(s.schema)).toEqual({});
  });

  it('refuses moves that would put a condition before the field it references', () => {
    expect(canMove(V3, 2, 0)).toBe(false); // issue_type above condition
    expect(canMove(V3, 1, 3)).toBe(false); // condition below its dependents
    const s = run(initEditor(V3), { type: 'move', id: 'issue_type', to: 0 });
    expect(ids(s)).toEqual(ids(initEditor(V3)));
    expect(s.notice).toMatch(/condition/);
    expect(validateSchema(s.schema)).toEqual({});
  });

  it('cannot remove, hide, retype or make optional the business field `condition`', () => {
    const s = run(
      initEditor(V3),
      { type: 'remove', id: 'condition' },
      { type: 'setType', id: 'condition', fieldType: 'text' },
      { type: 'update', id: 'condition', patch: { required: false } },
      { type: 'setRule', id: 'condition', key: 'visible_when', rule: { field: 'equipment', operator: 'equals', value: 'x' } },
      { type: 'setOptions', id: 'condition', options: [{ code: 'FINE', label: 'Fine' }] },
    );
    const condition = s.schema.fields.find((f) => f.id === 'condition')!;
    expect(condition.type).toBe('select');
    expect(condition.required).toBe(true);
    expect(condition.visible_when).toBeUndefined();
    expect(condition.options).toEqual(['GOOD', 'NEEDS_REPAIR', 'UNUSABLE']);
    expect(validateSchema(s.schema)).toEqual({});
  });

  it('allows relabelling business options while keeping codes', () => {
    const s = run(initEditor(V3), {
      type: 'setOptions',
      id: 'condition',
      options: [
        { code: 'GOOD', label: 'All good' },
        { code: 'NEEDS_REPAIR', label: 'Needs fixing' },
        { code: 'UNUSABLE', label: 'Unusable' },
      ],
    });
    expect(s.schema.fields[1]!.option_labels).toEqual({ GOOD: 'All good', NEEDS_REPAIR: 'Needs fixing', UNUSABLE: 'Unusable' });
  });

  it('removing a referenced field drops dependent conditions so the schema stays valid', () => {
    // Make a removable select that photos depend on.
    let s = run(
      initEditor(V3),
      { type: 'add', fieldType: 'boolean', label: 'Damaged' },
      { type: 'move', id: 'damaged', to: 2 },
      { type: 'setRule', id: 'notes', key: 'visible_when', rule: { field: 'damaged', operator: 'equals', value: true } },
    );
    expect(validateSchema(s.schema)).toEqual({});
    expect(visibleFields(s.schema, { condition: 'GOOD' }).map((f) => f.id)).not.toContain('notes');
    s = editorReducer(s, { type: 'remove', id: 'damaged' });
    expect(ids(s)).not.toContain('damaged');
    expect(s.schema.fields.find((f) => f.id === 'notes')!.visible_when).toBeUndefined();
    expect(s.notice).toMatch(/Notes/);
    expect(validateSchema(s.schema)).toEqual({});
  });

  it('removing an option referenced by a rule drops the rule', () => {
    let s = run(initEditor(V3), { type: 'setRule', id: 'notes', key: 'visible_when', rule: { field: 'issue_type', operator: 'equals', value: 'TEAR' } });
    expect(validateSchema(s.schema)).toEqual({});
    s = editorReducer(s, {
      type: 'setOptions',
      id: 'issue_type',
      options: [
        { code: 'BROKEN_ZIP', label: 'Zip' },
        { code: 'OTHER', label: 'Other' },
      ],
    });
    expect(s.schema.fields.find((f) => f.id === 'notes')!.visible_when).toBeUndefined();
    expect(validateSchema(s.schema)).toEqual({});
  });

  it('changing a field type strips properties that no longer apply', () => {
    const s = run(initEditor(V3), { type: 'setType', id: 'notes', fieldType: 'photo' });
    const notes = s.schema.fields.find((f) => f.id === 'notes')!;
    expect(notes.type).toBe('photo');
    expect(notes.max_length).toBeUndefined();
    expect(notes.max_count).toBe(3);
    expect(validateSchema(s.schema)).toEqual({});
  });

  it('renaming a field id updates rules that reference it', () => {
    let s = run(initEditor(V3), { type: 'add', fieldType: 'boolean', label: 'Washed' }, { type: 'add', fieldType: 'text', label: 'Wash notes' });
    s = run(s, { type: 'setRule', id: 'wash_notes', key: 'visible_when', rule: { field: 'washed', operator: 'equals', value: true } }, { type: 'rename', id: 'washed', newId: 'was_washed' });
    expect(s.schema.fields.find((f) => f.id === 'wash_notes')!.visible_when).toEqual({ field: 'was_washed', operator: 'equals', value: true });
    expect(validateSchema(s.schema)).toEqual({});
  });
});
