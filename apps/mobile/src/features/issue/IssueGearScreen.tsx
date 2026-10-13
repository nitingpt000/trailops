/**
 * Issue flow (spec §13): asset → batch member → size/condition/location → due date → confirm physical
 * handover → durable ISSUE_GEAR command. "Save issue on device" is a provisional local record, not a
 * central reservation; the allocation UUID is generated here so later offline returns can reference it.
 */
import React, {useMemo, useState} from 'react';
import {Pressable, Text, View} from 'react-native';
import {Calendar, CircleCheck, MapPin, Users, Wifi} from 'lucide-react-native';
import {SYNC_LABEL} from '@trailops/contracts';
import type {ScreenProps} from '../../app/navigation';
import {useDb, useSession} from '../../app/session';
import {triggerSync} from '../../app/startup';
import {useBatchMembers, useCampBatches, useItem, useOpenClaims, useQueue} from '../../database/hooks';
import {enqueue} from '../../sync/queue';
import {uuid} from '../../native/sha256';
import {Banner, Button, Card, Divider, Empty, ItemThumb, Row, Screen, Sheet} from '../../ui/components';
import {colors, space, type} from '../../ui/tokens';
import {addDays, formatDay, todayIso} from '../../ui/format';
import {useSync} from '../../sync/coordinator';
import {itemTitle, useItemViews} from '../equipment/model';

const GRACE_DAYS = 2; // proposed POC policy, mirrors the API's DUE_DATE_GRACE_DAYS

export function IssueGearScreen({route, navigation}: ScreenProps<'IssueGear'>) {
  const db = useDb();
  const {account, campId} = useSession();
  const online = useSync(s => s.online);
  const item = useItem(route.params.itemId);
  const v = useItemViews(item ? [item] : undefined)?.[0];
  const claims = useOpenClaims(item?.id);
  const today = todayIso();
  const batches = (useCampBatches(campId) ?? []).filter(b => b.active && b.end_date >= today);
  const [batchId, setBatchId] = useState<string | null>(null);
  const batch = batches.find(b => b.id === batchId) ?? batches[0];
  const members = useBatchMembers(batch?.id);
  const [trekkerId, setTrekkerId] = useState<string | null>(null);
  const trekker = members?.find(m => m.trekker_id === trekkerId) ?? null;
  const [due, setDue] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [sheet, setSheet] = useState<null | 'member' | 'batch' | 'due'>(null);
  const [savedOp, setSavedOp] = useState<string | null>(null);
  const saved = useQueue()?.find(q => q.operation_id === savedOp);

  const dueOptions = useMemo(() => {
    if (!batch) return [];
    const start = batch.start_date > today ? batch.start_date : today;
    const out: string[] = [];
    for (let d = start; d <= addDays(batch.end_date, GRACE_DAYS) && out.length < 14; d = addDays(d, 1)) out.push(d);
    return out;
  }, [batch, today]);
  const dueDate = due && dueOptions.includes(due) ? due : batch ? batch.end_date : null;

  if (!item || !v) return <Screen onBack={navigation.goBack}><Empty title="Item not available" /></Screen>;

  if (saved) {
    const state = saved.state;
    const tone = state === 'ACCEPTED' ? 'success' : state === 'CONFLICT' || state === 'REJECTED' ? 'error' : 'warning';
    return (
      <Screen title="Issue saved" onBack={() => navigation.popToTop()}
        footer={<Button title="Done" onPress={() => navigation.popToTop()} />}>
        <Card>
          <Text style={type.heading}>{item.tag} → {trekker?.display_name}</Text>
          <Text style={type.small}>Due back {formatDay(dueDate)}</Text>
        </Card>
        <Banner tone={tone} title={
          state === 'ACCEPTED' ? SYNC_LABEL.confirmed
            : state === 'CONFLICT' || state === 'REJECTED' ? SYNC_LABEL.review
              : `${SYNC_LABEL.saved} — ${SYNC_LABEL.awaiting.toLowerCase()}`}>
          {state === 'ACCEPTED' ? 'The server confirmed this allocation.'
            : state === 'CONFLICT' || state === 'REJECTED' ? (saved.error_message ?? 'This issue needs review in the Sync centre.')
              : 'The issue is stored durably on this device and will be sent automatically when a connection is available.'}
        </Banner>
        {state === 'CONFLICT' ? <Button title="Review conflict" variant="secondary" onPress={() => navigation.navigate('SyncCentre')} /> : null}
      </Screen>
    );
  }

  const blocked = !v.item || v.item.status !== 'READY' || v.locallyBusy || (claims?.length ?? 0) > 0;
  const save = async () => {
    if (!trekker || !batch || !dueDate || !account) return;
    const op = await enqueue(db, {accountId: account.accountId, deviceId: account.deviceId}, {
      type: 'ISSUE_GEAR',
      aggregate_id: item.id,
      expected_version: item.version,
      payload: {allocation_id: uuid(), trekker_id: trekker.trekker_id, batch_id: batch.id, due_date: dueDate,
        observed_location_id: item.location_id},
      summary: `Issue ${item.tag} to ${trekker.display_name ?? 'trekker'}`,
    });
    setSavedOp(op);
    triggerSync('issue');
  };

  return (
    <Screen title="Issue gear" subtitle="Confirm details and assign to trekker" onBack={navigation.goBack}
      footer={
        <>
          <Button testID="save-issue" title="Save issue on device" onPress={save}
            disabled={blocked || !trekker || !dueDate || !confirmed} />
          <View style={{flexDirection: 'row', gap: 6, justifyContent: 'center', alignItems: 'center', backgroundColor: '#FFF6D6', padding: 8, borderRadius: 8}}>
            <Wifi color={colors.text} size={16} />
            <Text style={type.small}>{online === false ? 'Offline · ' : ''}{SYNC_LABEL.awaiting} after saving</Text>
          </View>
        </>
      }>
      <Card style={{flexDirection: 'row', gap: space.m, alignItems: 'center'}}>
        <ItemThumb imageKey={v.category?.image_key} size={96} />
        <View style={{flex: 1}}>
          <Text style={type.heading}>{itemTitle(v)}</Text>
          <Text style={type.body}>{item.tag}{item.size ? ` · Size ${item.size}` : ''}</Text>
        </View>
      </Card>
      {blocked ? <Banner tone="error" title="Cannot issue this item">
        {v.locallyBusy ? 'There is already unsent work for this item on this device.' : (claims?.length ?? 0) > 0 ? 'Custody must be reconciled first.' : 'It is not available.'}
      </Banner> : null}
      <View>
        <Row testID="pick-trekker" title={trekker?.display_name ?? 'Choose trekker'} subtitle={trekker ? `Size hint ${trekker.size_hint ?? '—'}` : 'From the batch roster'}
          left={<Users color={colors.text} size={22} />} onPress={() => setSheet('member')} />
        <Divider />
        <Row title={batch ? `Batch ${batch.code}` : 'No active batch'} subtitle={batch ? `${batch.trek_name} · ${members?.length ?? 0} trekkers` : 'No batch at this camp is active'}
          left={<Users color={colors.muted} size={22} />} onPress={batches.length > 1 ? () => setSheet('batch') : undefined} />
        <Divider />
        <Row title="Condition at issue" subtitle="Ready — released after last inspection" left={<CircleCheck color={colors.success} size={22} />} />
        <Divider />
        <Row title={`Return date · ${formatDay(dueDate)}`} subtitle="Within the batch dates" left={<Calendar color={colors.text} size={22} />} onPress={() => setSheet('due')} />
        <Divider />
        <Row title={v.location?.label ?? 'Location'} subtitle="Handed over from" left={<MapPin color={colors.text} size={22} />} />
      </View>
      <Pressable testID="confirm-handover" accessibilityRole="checkbox" accessibilityState={{checked: confirmed}} onPress={() => setConfirmed(c => !c)}
        style={{flexDirection: 'row', gap: space.m, alignItems: 'center', minHeight: 48}}>
        <View style={{width: 26, height: 26, borderRadius: 6, borderWidth: 2, borderColor: colors.text, backgroundColor: confirmed ? colors.primary : 'transparent', alignItems: 'center', justifyContent: 'center'}}>
          {confirmed ? <Text style={{fontWeight: '900'}}>✓</Text> : null}
        </View>
        <Text style={[type.body, {flex: 1}]}>I have physically handed {item.tag} to the trekker</Text>
      </Pressable>

      <Sheet visible={sheet === 'member'} onClose={() => setSheet(null)} title="Choose trekker">
        {(members ?? []).filter(m => m.active).map(m => (
          <Row key={m.trekker_id} testID={`trekker-${m.display_name}`} title={m.display_name ?? 'Trekker'} subtitle={`Size hint ${m.size_hint ?? '—'}`}
            onPress={() => { setTrekkerId(m.trekker_id); setSheet(null); }} />
        ))}
      </Sheet>
      <Sheet visible={sheet === 'batch'} onClose={() => setSheet(null)} title="Choose batch">
        {batches.map(b => (
          <Row key={b.id} title={b.code} subtitle={`${b.trek_name} · ${formatDay(b.start_date)} – ${formatDay(b.end_date)}`}
            onPress={() => { setBatchId(b.id); setTrekkerId(null); setSheet(null); }} />
        ))}
      </Sheet>
      <Sheet visible={sheet === 'due'} onClose={() => setSheet(null)} title="Return date">
        {dueOptions.map(d => <Row key={d} title={formatDay(d)} onPress={() => { setDue(d); setSheet(null); }} />)}
      </Sheet>
    </Screen>
  );
}
