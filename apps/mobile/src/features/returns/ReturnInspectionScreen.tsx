/**
 * Return + inspection (spec §14). System fields come from the selected allocation, never editable
 * text. Drafts pin their form version and are saved after meaningful changes, so a restart or a new
 * published version never loses answers. Saving writes the command, attachment queue rows and draft
 * cleanup in one transaction.
 */
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Text, View} from 'react-native';
import {Q} from '@nozbe/watermelondb';
import {CloudUpload} from 'lucide-react-native';
import {pruneHidden, validateAnswers, type FormSchema, type FormVersionP, type Precondition} from '@trailops/contracts';
import type {ScreenProps} from '../../app/navigation';
import {useDb, useSession} from '../../app/session';
import {triggerSync} from '../../app/startup';
import {useActiveAllocation, useAllMembers, useFormDefinitions, useFormVersions, useItem} from '../../database/hooks';
import type {DraftRow, LocalRecord} from '../../database/models';
import {descriptor, discardPhoto, prepareAttachmentRows, type CapturedPhoto} from '../../sync/attachments';
import {enqueue} from '../../sync/queue';
import {uuid} from '../../native/sha256';
import {Banner, Button, Card, Empty, ItemThumb, Screen} from '../../ui/components';
import {colors, space, type} from '../../ui/tokens';
import {itemTitle, provisionalIssue, useItemViews} from '../equipment/model';
import {FormRenderer} from './FormRenderer';
import {PhotoCapture} from './PhotoCapture';

interface DraftValues {
  answers: Record<string, unknown>;
  photos: Record<string, CapturedPhoto[]>;
}

export function ReturnInspectionScreen({route, navigation}: ScreenProps<'ReturnInspection'>) {
  const db = useDb();
  const account = useSession(s => s.account);
  const item = useItem(route.params.itemId);
  const v = useItemViews(item ? [item] : undefined)?.[0];
  const allocation = useActiveAllocation(item?.id);
  const members = useAllMembers();
  const defs = useFormDefinitions();
  const versions = useFormVersions();
  const draftKey = `return:${route.params.itemId}`;
  const [draft, setDraft] = useState<LocalRecord<DraftRow> | null | undefined>(undefined);
  const [values, setValues] = useState<DraftValues>({answers: {}, photos: {}});
  const [pinnedVersionId, setPinnedVersionId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [captureFor, setCaptureFor] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Load existing draft once.
  useEffect(() => {
    db.get<LocalRecord<DraftRow>>('drafts').query(Q.where('screen_key', draftKey)).fetch().then(rows => {
      const d = rows[0] ?? null;
      setDraft(d);
      if (d) {
        setValues(JSON.parse(d.r.values_json));
        setPinnedVersionId(d.r.form_version_id);
      }
    });
  }, [db, draftKey]);

  const activeVersionId = defs?.find(d => d.key === 'return-inspection')?.active_version_id ?? null;
  const versionId = pinnedVersionId ?? activeVersionId;
  const formVersion: FormVersionP | undefined = versions?.find(fv => fv.id === versionId);
  const schema = formVersion?.schema as FormSchema | undefined;

  const provisional = v ? provisionalIssue(v) : null;
  const allocationId = allocation?.id ?? provisional?.allocationId ?? null;
  const trekkerName = allocation ? members?.find(m => m.trekker_id === allocation.trekker_id)?.display_name : provisional?.trekkerName;

  const answers = useMemo(() => ({...values.answers, equipment: item?.id}), [values.answers, item?.id]);

  const persistDraft = (next: DraftValues) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      if (!versionId) return;
      await db.write(async () => {
        if (draft) {
          await draft.update(d => d.set({values_json: JSON.stringify(next), saved_at: Date.now()}));
        } else {
          const created = await db.get<LocalRecord<DraftRow>>('drafts').create(d => {
            Object.assign(d._raw, {owner_id: account?.accountId ?? '', screen_key: draftKey, entity_id: item?.id ?? null,
              form_version_id: versionId, values_json: JSON.stringify(next), saved_at: Date.now()});
          });
          setDraft(created);
          setPinnedVersionId(versionId);
        }
      });
    }, 400);
  };
  const update = (next: DraftValues) => {
    setValues(next);
    persistDraft(next);
  };

  if (item === null || (item && !allocationId && v)) {
    return <Screen onBack={navigation.goBack}><Empty title="Nothing to return" body="This item has no active or pending allocation on this device." /></Screen>;
  }
  if (!item || !v || !schema || draft === undefined) return <Screen onBack={navigation.goBack}><Text>Loading form…</Text></Screen>;

  const allPhotos = Object.values(values.photos).flat();
  const save = async () => {
    setSaveError(null);
    const pruned = pruneHidden(schema, answers);
    // Photos belonging to hidden photo fields are not submitted.
    const visiblePhotoFields = Object.keys(pruned).filter(k => schema.fields.find(f => f.id === k)?.type === 'photo');
    const photos = visiblePhotoFields.flatMap(k => values.photos[k] ?? []);
    for (const k of visiblePhotoFields) pruned[k] = (values.photos[k] ?? []).map(p => p.attachment_id);
    const errs = validateAnswers(schema, pruned, new Set(photos.map(p => p.attachment_id)));
    if (pruned.condition === 'NEEDS_REPAIR' && photos.length === 0) errs.photos = 'Add at least one photo of the damage';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const inspectionId = uuid();
    const preconditions: Precondition[] = [];
    const dependsOn: string[] = [];
    if (allocation) preconditions.push({entity: 'allocation', id: allocation.id, expected_version: allocation.version});
    if (!allocation && provisional) {
      // Offline issue-then-return chain (spec §18): depend on the issue and resolve the item version from its receipt.
      dependsOn.push(provisional.op.operation_id);
      preconditions.push({entity: 'equipment', id: item.id, after_operation_id: provisional.op.operation_id});
    }
    try {
      await enqueue(db, {accountId: account!.accountId, deviceId: account!.deviceId}, {
        type: 'SUBMIT_RETURN',
        aggregate_id: item.id,
        depends_on: dependsOn,
        preconditions,
        payload: {inspection_id: inspectionId, allocation_id: allocationId!, form_version_id: formVersion!.id, answers: pruned,
          attachments: photos.map(descriptor)},
        summary: `Return ${item.tag} · ${String(pruned.condition).replace('_', ' ').toLowerCase()}`,
      }, async opId => [
        ...prepareAttachmentRows(db, opId, inspectionId, photos),
        ...(draft ? [draft.prepareDestroyPermanently()] : []),
      ]);
    } catch (e) {
      // Draft stays intact; nothing was saved (spec §7).
      setSaveError(String((e as Error)?.message ?? e));
      return;
    }
    // Photos captured but not submitted (hidden field) are discarded only after a successful save.
    for (const p of allPhotos) if (!photos.includes(p)) await discardPhoto(p);
    triggerSync('return');
    navigation.replace('EquipmentDetail', {itemId: item.id});
  };

  return (
    <Screen title="Return inspection" subtitle="Check condition and record any issues" onBack={navigation.goBack}
      footer={
        <>
          <Button testID="save-inspection" title="Save inspection" onPress={save} />
          <View style={{flexDirection: 'row', gap: 6, justifyContent: 'center', alignItems: 'center'}}>
            <CloudUpload color={colors.muted} size={16} />
            <Text style={type.small}>Photos upload when connected</Text>
          </View>
        </>
      }>
      <Card style={{flexDirection: 'row', gap: space.m, alignItems: 'center'}}>
        <ItemThumb imageKey={v.category?.image_key} size={84} />
        <View style={{flex: 1, gap: 2}}>
          <Text style={type.heading}>{itemTitle(v)}</Text>
          <Text style={type.body}>{item.tag}{item.size ? ` · Size ${item.size}` : ''}</Text>
          <Text style={type.small}>Issued to {trekkerName ?? 'trekker'}{provisional && !allocation ? ' (not yet confirmed)' : ''}</Text>
        </View>
      </Card>
      {formVersion && activeVersionId && formVersion.id !== activeVersionId ? (
        <Banner tone="info">{`This draft uses form version ${formVersion.number}. A newer version exists; your answers are kept as recorded.`}</Banner>
      ) : null}
      {saveError ? <Banner tone="error" title="Not saved — try again">{saveError}</Banner> : null}
      <FormRenderer
        schema={schema}
        answers={answers}
        errors={errors}
        photos={values.photos}
        equipmentLabel={`${item.tag} · ${itemTitle(v)}`}
        onChange={(id, val) => update({...values, answers: {...values.answers, [id]: val}})}
        onAddPhoto={id => setCaptureFor(id)}
        onRemovePhoto={async (id, attId) => {
          const p = (values.photos[id] ?? []).find(x => x.attachment_id === attId);
          update({...values, photos: {...values.photos, [id]: (values.photos[id] ?? []).filter(x => x.attachment_id !== attId)}});
          if (p) await discardPhoto(p);
        }}
      />
      <PhotoCapture visible={!!captureFor} onClose={() => setCaptureFor(null)}
        onCaptured={p => {
          const id = captureFor!;
          update({...values, photos: {...values.photos, [id]: [...(values.photos[id] ?? []), p]}});
        }} />
    </Screen>
  );
}
