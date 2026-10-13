import { Dropdown } from '../../ui/Dropdown';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  AlignLeft,
  ArrowDown,
  ArrowUp,
  Barcode,
  Calendar,
  GripVertical,
  Hash,
  Image as ImageIcon,
  Info,
  List,
  Lock,
  Plus,
  ToggleLeft,
  Trash2,
  Type,
} from 'lucide-react';
import { FIELD_TYPES, validateSchema, type FieldType, type FormSchema } from '@trailops/contracts';
import { useForms } from '../../api/queries';
import type { FormDefinitionRow, FormVersionRow } from '../../api/types';
import { useCommand } from '../../api/useCommand';
import { useSession } from '../../app/session';
import { Badge, Button, Callout, Dialog, EmptyState, ErrorState, fmtDate, ReceiptNotice, Spinner } from '../../ui/kit';
import { canMove, dependents, editorReducer, initEditor, lockedField, TYPE_LABEL } from './editorReducer';
import { MobilePreview } from './MobilePreview';
import { FieldConfig } from './FieldConfig';

const TYPE_ICON: Record<FieldType, typeof Type> = {
  text: Type,
  textarea: AlignLeft,
  integer: Hash,
  decimal: Hash,
  boolean: ToggleLeft,
  select: List,
  date: Calendar,
  photo: ImageIcon,
  equipment_ref: Barcode,
};

const STATUS_TONE = { DRAFT: 'info', PUBLISHED: 'success', RETIRED: 'neutral' } as const;

function Editor({ def, draft, base, nextNumber }: { def: FormDefinitionRow; draft: FormVersionRow | null; base: FormSchema; nextNumber: number }) {
  const { can } = useSession();
  const canEdit = can('forms.edit', null);
  const canPublish = can('forms.publish', null);
  const [state, dispatch] = useReducer(editorReducer, base, initEditor);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const dragFrom = useRef<number | null>(null);
  const save = useCommand({ success: (r) => `Draft v${String(r.data?.number ?? nextNumber)} saved` });
  const publish = useCommand({ success: (r) => `Version ${String(r.data?.number ?? nextNumber)} published`, onAccepted: () => setConfirm(false) });

  const errors = useMemo(() => validateSchema(state.schema), [state.schema]);
  const errorCount = Object.keys(errors).length;
  const selected = state.schema.fields.find((f) => f.id === state.selectedId);
  const publishedIds = useMemo(
    () => new Set(def.versions.filter((v) => v.status !== 'DRAFT').flatMap((v) => v.schema.fields.map((f) => f.id))),
    [def.versions],
  );
  const fieldHasError = (i: number, id: string) =>
    Object.keys(errors).some((k) => k === `fields.${i}` || k.startsWith(`fields.${i}.`) || k === `fields.${id}` || k.startsWith(`fields.${id}.`));

  const doSave = () =>
    void save.submit({
      type: 'FORM_DRAFT_SAVE',
      aggregate_id: def.id,
      preconditions: draft ? [{ entity: 'form_version', id: draft.id, expected_version: draft.version }] : undefined,
      payload: { schema: { ...state.schema, key: def.key } },
    });

  const publishBlocked = !draft
    ? 'Save a draft first.'
    : state.dirty
      ? 'You have unsaved changes. Save the draft, then publish exactly what was saved.'
      : errorCount > 0
        ? `${errorCount} validation problem${errorCount > 1 ? 's' : ''} must be fixed.`
        : null;

  const removeTarget = removing ? state.schema.fields.find((f) => f.id === removing) : null;
  const removeDeps = removing ? dependents(state.schema, removing) : [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            {def.title}{' '}
            <Badge tone="info">
              Version {draft?.number ?? nextNumber} · {draft ? 'Draft' : 'New draft'}
              {state.dirty ? ' (unsaved)' : ''}
            </Badge>
          </h1>
          <p className="page-sub">Create and configure the inspection form used when equipment is returned at trek end.</p>
        </div>
        <div className="btn-row">
          {canEdit && (
            <Button onClick={doSave} pending={save.pending} disabled={!state.dirty && !!draft}>
              Save draft
            </Button>
          )}
          {canPublish && (
            <Button variant="primary" disabled={!!publishBlocked} title={publishBlocked ?? undefined} onClick={() => setConfirm(true)}>
              Publish version {draft?.number ?? nextNumber}
            </Button>
          )}
        </div>
      </div>
      {!canPublish && canEdit && <p className="muted small">You can save drafts. Publishing needs the forms.publish permission (administrators).</p>}
      {canPublish && publishBlocked && <p className="muted small">Publish unavailable: {publishBlocked}</p>}
      {state.notice && (
        <Callout tone="info" action={<Button className="btn-sm" onClick={() => dispatch({ type: 'clearNotice' })}>Dismiss</Button>}>
          {state.notice}
        </Callout>
      )}
      {errorCount > 0 && (
        <Callout tone="error" title={`Schema has ${errorCount} problem${errorCount > 1 ? 's' : ''} — publishing is blocked`}>
          <ul className="field-errors">
            {Object.entries(errors).map(([k, v]) => (
              <li key={k}>
                <code>{k}</code>: {v}
              </li>
            ))}
          </ul>
        </Callout>
      )}
      <ReceiptNotice outcome={save.outcome} />

      <div className="editor">
        <section className="panel editor-col" aria-labelledby="fields-h">
          <h2 id="fields-h" className="section-title">Form fields</h2>
          <p className="muted small">Drag to reorder, or use the arrows. Select a field to edit it.</p>
          <ol className="field-list">
            {state.schema.fields.map((f, i) => {
              const Icon = TYPE_ICON[f.type] ?? Type;
              const locked = !!lockedField(state.schema.key, f.id);
              return (
                <li
                  key={f.id}
                  className={`field-item ${state.selectedId === f.id ? 'active' : ''} ${fieldHasError(i, f.id) ? 'has-error' : ''}`}
                  draggable={canEdit}
                  onDragStart={() => (dragFrom.current = i)}
                  onDragOver={(e) => {
                    if (dragFrom.current !== null && canMove(state.schema, dragFrom.current, i)) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragFrom.current !== null) dispatch({ type: 'move', id: state.schema.fields[dragFrom.current]!.id, to: i });
                    dragFrom.current = null;
                  }}
                  onDragEnd={() => (dragFrom.current = null)}
                >
                  <span className="field-num" aria-hidden>{i + 1}</span>
                  <button className="field-btn" aria-current={state.selectedId === f.id || undefined} onClick={() => dispatch({ type: 'select', id: f.id })}>
                    <Icon size={20} aria-hidden />
                    <span className="field-name">
                      {f.label || f.id}
                      {(f.required || f.required_when) && <span className="req" aria-label="required"> *</span>}
                      <span className="muted small block">
                        {TYPE_LABEL[f.type]}
                        {f.visible_when ? ' · conditional' : ''}
                      </span>
                    </span>
                    {locked && <Lock size={16} aria-label="Business field" />}
                  </button>
                  <span className="field-tools">
                    <button className="icon-btn sm" aria-label={`Move ${f.label || f.id} up`} disabled={!canEdit || !canMove(state.schema, i, i - 1)} onClick={() => dispatch({ type: 'move', id: f.id, to: i - 1 })}>
                      <ArrowUp size={16} />
                    </button>
                    <button className="icon-btn sm" aria-label={`Move ${f.label || f.id} down`} disabled={!canEdit || !canMove(state.schema, i, i + 1)} onClick={() => dispatch({ type: 'move', id: f.id, to: i + 1 })}>
                      <ArrowDown size={16} />
                    </button>
                    <button
                      className="icon-btn sm"
                      aria-label={locked ? `${f.label || f.id} cannot be removed` : `Remove ${f.label || f.id}`}
                      title={locked ? 'Business field — cannot be removed' : 'Remove field'}
                      disabled={!canEdit || locked}
                      onClick={() => setRemoving(f.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                    <GripVertical size={18} aria-hidden className="grip" />
                  </span>
                </li>
              );
            })}
          </ol>
          {canEdit && (
            <div className="add-field">
              <Button icon={<Plus size={18} aria-hidden />} className="btn-block" aria-expanded={adding} onClick={() => setAdding((a) => !a)} disabled={state.schema.fields.length >= 40}>
                Add field
              </Button>
              {adding && (
                <ul className="type-menu" aria-label="Field types">
                  {FIELD_TYPES.map((t) => {
                    const Icon = TYPE_ICON[t];
                    return (
                      <li key={t}>
                        <button
                          onClick={() => {
                            dispatch({ type: 'add', fieldType: t });
                            setAdding(false);
                          }}
                        >
                          <Icon size={18} aria-hidden /> {TYPE_LABEL[t]}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </section>

        <section className="editor-col preview-col" aria-labelledby="preview-h">
          <h2 id="preview-h" className="section-title">Form preview (mobile)</h2>
          <MobilePreview schema={state.schema} selectedId={state.selectedId} onSelect={(id) => dispatch({ type: 'select', id })} />
        </section>

        <section className="panel editor-col" aria-labelledby="config-h">
          <h2 id="config-h" className="section-title">Field configuration</h2>
          <p className="muted small">Configure how this field appears and behaves.</p>
          <FieldConfig schema={state.schema} field={selected} errors={errors} publishedIds={publishedIds} readOnly={!canEdit} dispatch={dispatch} />
          <Callout tone="info">Downloaded form versions remain available offline. New versions apply after sync; drafts already started keep their original version.</Callout>
        </section>
      </div>

      <section className="panel history" aria-labelledby="hist-h">
        <h2 id="hist-h" className="section-title">Version history</h2>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Status</th>
              <th scope="col">Fields</th>
              <th scope="col">Published</th>
              <th scope="col">Hash</th>
            </tr>
          </thead>
          <tbody>
            {def.versions.map((v) => (
              <tr key={v.id}>
                <td>
                  v{v.number}
                  {v.id === def.active_version_id && <Badge tone="success">Active</Badge>}
                </td>
                <td>
                  <Badge tone={STATUS_TONE[v.status]}>{v.status === 'DRAFT' ? 'Draft' : v.status === 'PUBLISHED' ? 'Published' : 'Retired'}</Badge>
                </td>
                <td>{v.schema.fields?.length ?? 0}</td>
                <td>{fmtDate(v.published_at)}</td>
                <td>
                  <code>{v.schema_hash.slice(0, 12)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {confirm && draft && (
        <Dialog
          title={`Publish ${def.title} v${draft.number}?`}
          onClose={() => setConfirm(false)}
          footer={
            <>
              <Button onClick={() => setConfirm(false)}>Cancel</Button>
              <Button
                variant="primary"
                pending={publish.pending}
                onClick={() =>
                  void publish.submit({ type: 'FORM_PUBLISH', aggregate_id: draft.id, payload: { expected_hash: draft.schema_hash } })
                }
              >
                Publish version {draft.number}
              </Button>
            </>
          }
        >
          <ul className="bullets">
            <li>Published versions are <strong>immutable</strong>: this JSON and its hash never change. Further edits become version {draft.number + 1}.</li>
            <li>Version {draft.number} becomes the active version that devices download on their next sync.</li>
            <li>Devices keep older versions for drafts already in progress, and inspections already submitted keep the version they were recorded with.</li>
          </ul>
          <p className="muted small">
            Publishing hash <code>{draft.schema_hash.slice(0, 16)}…</code> — if the draft changed since you loaded it, the server refuses and asks you to review again.
          </p>
          <ReceiptNotice outcome={publish.outcome} />
        </Dialog>
      )}
      {removeTarget && (
        <Dialog
          title={`Remove “${removeTarget.label || removeTarget.id}”?`}
          onClose={() => setRemoving(null)}
          footer={
            <>
              <Button onClick={() => setRemoving(null)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  dispatch({ type: 'remove', id: removeTarget.id });
                  setRemoving(null);
                }}
              >
                Remove field
              </Button>
            </>
          }
        >
          <p>The field disappears from the next version only. Answers already submitted under earlier versions are unchanged.</p>
          {removeDeps.length > 0 && (
            <Callout tone="warning">
              Conditions on {removeDeps.map((d) => d.label || d.id).join(', ')} depend on this field and will be removed.
            </Callout>
          )}
        </Dialog>
      )}
    </>
  );
}

export function FormsPage() {
  const forms = useForms();
  const [defId, setDefId] = useState<string | null>(null);
  const def = forms.data?.find((d) => d.id === defId) ?? forms.data?.[0];
  useEffect(() => {
    if (def && def.id !== defId) setDefId(def.id);
  }, [def, defId]);

  if (forms.isLoading) return <div className="page"><Spinner label="Loading forms" /></div>;
  if (forms.error) return <div className="page"><ErrorState error={forms.error} onRetry={() => void forms.refetch()} /></div>;
  if (!def) return <div className="page"><EmptyState icon={<Info size={32} />} title="No form definitions" /></div>;

  const draft = def.versions.find((v) => v.status === 'DRAFT') ?? null;
  const active = def.versions.find((v) => v.id === def.active_version_id) ?? def.versions.find((v) => v.status === 'PUBLISHED');
  const base: FormSchema = draft?.schema ?? active?.schema ?? { schema_version: 1, key: def.key, title: def.title, fields: [] };
  const nextNumber = Math.max(0, ...def.versions.map((v) => v.number)) + 1;
  // Remount the editor whenever the server draft changes (save/publish), so it starts from server truth.
  const editorKey = `${def.id}:${draft?.id ?? 'none'}:${draft?.version ?? 0}:${active?.id ?? ''}`;

  return (
    <div className="page">
      {forms.data && forms.data.length > 1 && (
        <label className="filter">
          <span>Form</span>
          <Dropdown aria-label="Form" value={def.id} onChange={(e) => setDefId(e.target.value)}>
            {forms.data.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </Dropdown>
        </label>
      )}
      <Editor key={editorKey} def={def} draft={draft} base={base} nextNumber={nextNumber} />
    </div>
  );
}
