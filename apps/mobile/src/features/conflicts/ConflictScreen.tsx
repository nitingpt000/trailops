/**
 * Allocation conflict (spec §19). The first accepted server allocation wins the database decision,
 * not necessarily physical custody. The local claim stays visible until explicitly reconciled.
 * Replacement and cancellation can be captured offline; a supervisor reassignment is console-only.
 */
import React, {useState} from 'react';
import {Text, View} from 'react-native';
import {CircleCheck, Clock} from 'lucide-react-native';
import type {ScreenProps} from '../../app/navigation';
import {can, useDb, useSession} from '../../app/session';
import {triggerSync} from '../../app/startup';
import {useCampEquipment, useConflict, useItem, useQueue} from '../../database/hooks';
import {enqueue} from '../../sync/queue';
import {uuid} from '../../native/sha256';
import {Banner, Button, Card, Divider, Empty, Field, Input, ItemThumb, Row, Screen, Sheet} from '../../ui/components';
import {colors, space, type} from '../../ui/tokens';
import {formatTime} from '../../ui/format';
import {itemTitle, useItemViews} from '../equipment/model';

export function ConflictScreen({route, navigation}: ScreenProps<'ConflictDetail'>) {
  const db = useDb();
  const {account, campId, me} = useSession();
  const conflict = useConflict(route.params.conflictId);
  const item = useItem(conflict?.item_id);
  const v = useItemViews(item ? [item] : undefined)?.[0];
  const campItems = useCampEquipment(campId);
  const candidates = useItemViews((campItems ?? []).filter(i => i.status === 'READY' && i.category_id === item?.category_id));
  const pendingResolution = (useQueue(['QUEUED', 'SENDING', 'RETRY_WAIT', 'DEPENDENCY_WAIT']) ?? [])
    .find(q => q.type === 'RESOLVE_ALLOCATION_CONFLICT' && q.aggregate_id === route.params.conflictId);
  const [picking, setPicking] = useState(false);
  const [note, setNote] = useState('');

  if (conflict === null) return <Screen onBack={navigation.goBack}><Empty title="Conflict not on this device" /></Screen>;
  if (!conflict) return <Screen onBack={navigation.goBack}><Text>Loading…</Text></Screen>;
  const d = conflict.details;
  const resolve = async (payload: Parameters<typeof enqueue>[2]['payload'], summary: string) => {
    await enqueue(db, {accountId: account!.accountId, deviceId: account!.deviceId}, {
      type: 'RESOLVE_ALLOCATION_CONFLICT', aggregate_id: conflict.id,
      preconditions: [{entity: 'conflict', id: conflict.id, expected_version: conflict.version}],
      payload: payload as never, summary,
    });
    triggerSync('conflict');
    navigation.goBack();
  };
  const allowed = can(me, 'conflict.resolve_local') || can(me, 'conflict.resolve');

  return (
    <Screen title="Resolve allocation conflict" onBack={navigation.goBack}>
      <Banner tone="error" title={conflict.code === 'ITEM_ALREADY_ALLOCATED' ? 'Equipment already allocated' : 'Issue not accepted'}>
        {d.message}
      </Banner>
      <Card style={{flexDirection: 'row', gap: space.m, alignItems: 'center'}}>
        <ItemThumb imageKey={v?.category?.image_key} size={72} />
        <View>
          <Text style={type.heading}>{d.item_tag}</Text>
          <Text style={type.small}>{v ? itemTitle(v) : ''}{item?.size ? ` · ${item.size}` : ''}</Text>
        </View>
      </Card>
      <Text style={type.heading}>Two claims found</Text>
      {d.confirmed ? (
        <Row title={d.confirmed.trekker_name ?? 'Another batch (details not in your scope)'}
          subtitle={`Confirmed · ${d.confirmed.batch_code ?? ''} · ${formatTime(d.confirmed.issued_at)}`}
          left={<CircleCheck color={colors.success} size={26} />} />
      ) : <Row title="Item was not available" subtitle={`Server status: ${d.item_status.toLowerCase()}`} left={<CircleCheck color={colors.success} size={26} />} />}
      <Divider />
      <Row title={d.proposed.trekker_name ?? 'Your local issue'}
        subtitle={`Recorded offline (your local issue) · ${d.proposed.observed_at ? formatTime(d.proposed.observed_at) : ''}`}
        left={<Clock color={colors.info} size={26} />} />
      <Banner tone="neutral">The confirmed allocation stays active. Choose replacement gear for your trekker, or record that you retrieved the item.</Banner>
      {conflict.state !== 'OPEN' ? <Banner tone="success">Resolved ({conflict.resolution?.toLowerCase().replace(/_/g, ' ')}).</Banner> : null}
      {pendingResolution ? <Banner tone="warning" title="Resolution saved on this device">{pendingResolution.summary}</Banner> : null}
      {conflict.state === 'OPEN' && !pendingResolution && allowed ? (
        <>
          <Field label="What happened physically? *" hint="Required for the audit trail">
            <Input testID="conflict-note" value={note} onChangeText={setNote} multiline maxLength={500}
              placeholder="e.g. Gave Priya JKT-020 instead; retrieved JKT-018" />
          </Field>
          <Button testID="choose-replacement" title="Choose replacement item" disabled={note.trim().length < 3} onPress={() => setPicking(true)} />
          <Button testID="cancel-local" title="Cancel local issue" variant="secondary" disabled={note.trim().length < 3}
            onPress={() => resolve({resolution: 'CANCEL_LOCAL_CLAIM', note}, `Cancel local issue of ${d.item_tag}`)} />
        </>
      ) : null}
      <Sheet visible={picking} onClose={() => setPicking(false)} title="Replacement gear (ready now)">
        {(candidates ?? []).filter(c => !c.locallyBusy).map(c => (
          <Row key={c.item.id} testID={`replace-${c.item.tag}`} title={c.item.tag} subtitle={`${itemTitle(c)}${c.item.size ? ` · ${c.item.size}` : ''}`}
            onPress={async () => {
              setPicking(false);
              await resolve({
                resolution: 'REPLACE', note,
                replacement: {item_id: c.item.id, allocation_id: uuid(), due_date: d.proposed.due_date, expected_version: c.item.version},
              }, `Replace ${d.item_tag} with ${c.item.tag} for ${d.proposed.trekker_name ?? 'trekker'}`);
            }} />
        ))}
        {!(candidates ?? []).length ? <Empty title="No ready replacement" body="No item of this category is ready at this camp." /> : null}
      </Sheet>
    </Screen>
  );
}
