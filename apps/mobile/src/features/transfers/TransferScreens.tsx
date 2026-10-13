/**
 * Tagged-asset handovers (spec §16). The mockups' quantity steppers are replaced by per-tag
 * checklists grouped by category: quantities are derived from tags, never typed counters.
 */
import React, {useEffect, useMemo, useState} from 'react';
import {Pressable, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {Check, ChevronDown, ChevronRight, CircleAlert, CircleCheck, MapPin, Truck} from 'lucide-react-native';
import {Q} from '@nozbe/watermelondb';
import {SYNC_LABEL, TRANSFER_LABEL, type EquipmentP, type TransferP} from '@trailops/contracts';
import type {RootStack, ScreenProps} from '../../app/navigation';
import {can, useDb, useSession} from '../../app/session';
import {triggerSync} from '../../app/startup';
import {
  useAllLocations, useCampEquipment, useCampLocations, useItem, useProjection, useQueue, useTransferLines, useTransfers,
} from '../../database/hooks';
import type {DraftRow, LocalRecord} from '../../database/models';
import {api} from '../../sync/api';
import {enqueue} from '../../sync/queue';
import {uuid} from '../../native/sha256';
import {Banner, Button, Card, Divider, Empty, Field, Input, ItemThumb, Pill, Row, Screen, Sheet} from '../../ui/components';
import {colors, radius, space, type} from '../../ui/tokens';
import {formatTime} from '../../ui/format';
import {itemTitle, useItemViews, type ItemView} from '../equipment/model';

export function TransfersScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStack>>();
  const {campId, me} = useSession();
  const transfers = useTransfers();
  const campLocs = useCampLocations(campId);
  const allLocs = useAllLocations();
  const pending = useQueue(['QUEUED', 'SENDING', 'RETRY_WAIT', 'DEPENDENCY_WAIT', 'AUTH_BLOCKED']);
  const locIds = new Set((campLocs ?? []).map(l => l.id));
  const orgLocs = useCachedOrgLocations();
  const label = (id: string) =>
    allLocs?.find(l => l.id === id)?.label ?? orgLocs?.find(l => l.id === id)?.label ?? 'another camp';
  const pendingReceipts = new Set((pending ?? []).filter(p => p.type === 'RECEIVE_TRANSFER').map(p => p.aggregate_id));
  const pendingDispatches = (pending ?? []).filter(p => p.type === 'DISPATCH_TRANSFER');
  const incoming = (transfers ?? []).filter(t => locIds.has(t.to_location_id)).sort((a, b) => b.dispatched_at.localeCompare(a.dispatched_at));
  const outgoing = (transfers ?? []).filter(t => locIds.has(t.from_location_id)).sort((a, b) => b.dispatched_at.localeCompare(a.dispatched_at));

  const row = (t: TransferP, dir: 'in' | 'out') => {
    const waiting = pendingReceipts.has(t.id);
    return (
      <Row key={t.id} testID={`transfer-${t.code}`} title={`${t.code} · ${dir === 'in' ? `from ${label(t.from_location_id)}` : `to ${label(t.to_location_id)}`}`}
        subtitle={`Dispatched ${formatTime(t.dispatched_at)}`}
        right={<Pill label={waiting ? SYNC_LABEL.saved : TRANSFER_LABEL[t.state]} tone={waiting ? 'warning' : t.state === 'DISCREPANCY' ? 'error' : t.state === 'DISPATCHED' ? 'info' : 'success'} />}
        onPress={dir === 'in' && t.state === 'DISPATCHED' && !waiting && can(me, 'transfer.receive') ? () => nav.navigate('TransferReceive', {transferId: t.id}) : undefined} />
    );
  };

  return (
    <>
      <Screen title="Handovers" subtitle="Tagged equipment moving between locations"
        footer={can(me, 'transfer.dispatch') ? <Button testID="new-dispatch" title="Dispatch handover" icon={<Truck color={colors.text} size={22} />} onPress={() => nav.navigate('TransferDispatch')} /> : undefined}>
        <Text style={type.heading}>Arriving here</Text>
        {incoming.length ? incoming.map(t => row(t, 'in')) : <Text style={type.small}>No handovers addressed to this camp on this device.</Text>}
        <Divider />
        <Text style={type.heading}>Sent from here</Text>
        {pendingDispatches.map(p => (
          <Row key={p.operation_id} title={p.summary} subtitle={`Saved ${formatTime(p.client_recorded_at)}`} right={<Pill label={SYNC_LABEL.awaiting} tone="warning" />} />
        ))}
        {outgoing.length || pendingDispatches.length ? outgoing.map(t => row(t, 'out')) : <Text style={type.small}>Nothing dispatched yet.</Text>}
      </Screen>
    </>
  );
}

/** Groups READY items at the origin by category; each group expands to its tags. */
function TagChecklist({views, selected, toggle}: {views: ItemView[]; selected: Set<string>; toggle: (id: string) => void}) {
  const groups = useMemo(() => {
    const m = new Map<string, ItemView[]>();
    for (const v of views) m.set(itemTitle(v), [...(m.get(itemTitle(v)) ?? []), v]);
    return [...m.entries()];
  }, [views]);
  const [open, setOpen] = useState<string | null>(groups[0]?.[0] ?? null);
  return (
    <View style={{gap: space.s}}>
      {groups.map(([name, list]) => {
        const n = list.filter(v => selected.has(v.item.id)).length;
        return (
          <Card key={name} style={{padding: 0}}>
            <Pressable accessibilityRole="button" onPress={() => setOpen(open === name ? null : name)}
              style={{flexDirection: 'row', alignItems: 'center', gap: space.m, padding: space.m}}>
              <ItemThumb imageKey={list[0].category?.image_key} size={48} />
              <View style={{flex: 1}}>
                <Text style={[type.body, {fontWeight: '700'}]}>{name}</Text>
                <Text style={type.small}>{n} selected · {list.length} ready here</Text>
              </View>
              {open === name ? <ChevronDown color={colors.text} size={20} /> : <ChevronRight color={colors.text} size={20} />}
            </Pressable>
            {open === name ? list.map(v => (
              <Pressable key={v.item.id} testID={`tag-${v.item.tag}`} accessibilityRole="checkbox" accessibilityState={{checked: selected.has(v.item.id)}}
                onPress={() => toggle(v.item.id)}
                style={{flexDirection: 'row', alignItems: 'center', gap: space.m, paddingHorizontal: space.m, minHeight: 48, borderTopWidth: 1, borderTopColor: colors.divider}}>
                <View style={{width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: colors.text, alignItems: 'center', justifyContent: 'center',
                  backgroundColor: selected.has(v.item.id) ? colors.primary : 'transparent'}}>
                  {selected.has(v.item.id) ? <Check color={colors.text} size={16} strokeWidth={3} /> : null}
                </View>
                <Text style={type.body}>{v.item.tag}{v.item.size ? ` · ${v.item.size}` : ''}</Text>
              </Pressable>
            )) : null}
          </Card>
        );
      })}
    </View>
  );
}

interface OrgLocation {id: string; label: string; camp_id: string; camp_name: string}

const ORG_LOCATIONS_KEY = 'cache:org-locations';

/** Labels for locations outside this camp's scope, cached from the last online lookup. */
function useCachedOrgLocations(): OrgLocation[] | undefined {
  const db = useDb();
  const [locs, setLocs] = useState<OrgLocation[]>();
  useEffect(() => {
    const sub = db.get<LocalRecord<DraftRow>>('drafts').query(Q.where('screen_key', ORG_LOCATIONS_KEY)).observe()
      .subscribe(rows => setLocs(rows[0] ? JSON.parse(rows[0].r.values_json) : undefined));
    return () => sub.unsubscribe();
  }, [db]);
  return locs;
}

export function TransferDispatchScreen({navigation}: ScreenProps<'TransferDispatch'>) {
  const db = useDb();
  const {account, campId} = useSession();
  const campLocs = useCampLocations(campId) ?? [];
  const [origin, setOrigin] = useState<string | null>(null);
  const originId = origin ?? campLocs[0]?.id ?? null;
  const items = useCampEquipment(campId);
  const views = useItemViews((items ?? []).filter(i => i.status === 'READY' && i.location_id === originId));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dest, setDest] = useState<OrgLocation | null>(null);
  const [orgLocs, setOrgLocs] = useState<OrgLocation[] | null>(null);
  const [note, setNote] = useState('');
  const [sheet, setSheet] = useState<null | 'origin' | 'dest'>(null);

  // Destinations outside this camp are not in the scoped download; fetch when online and cache locally.
  useEffect(() => {
    const cacheKey = ORG_LOCATIONS_KEY;
    (async () => {
      const rows = await db.get<LocalRecord<DraftRow>>('drafts').query(Q.where('screen_key', cacheKey)).fetch();
      if (rows[0]) setOrgLocs(JSON.parse(rows[0].r.values_json));
      try {
        const r = await api<{items: OrgLocation[]}>({accountId: account!.accountId}, 'GET', '/v1/locations');
        setOrgLocs(r.items);
        await db.write(async () => {
          if (rows[0]) await rows[0].update(d => d.set({values_json: JSON.stringify(r.items), saved_at: Date.now()}));
          else await db.get<LocalRecord<DraftRow>>('drafts').create(d => {
            Object.assign(d._raw, {owner_id: account!.accountId, screen_key: cacheKey, entity_id: null, form_version_id: null,
              values_json: JSON.stringify(r.items), saved_at: Date.now()});
          });
        });
      } catch {
        // offline: cached list (if any) is used
      }
    })();
  }, [db, account]);

  const available = (views ?? []).filter(v => !v.locallyBusy);
  const destinations = (orgLocs ?? []).filter(l => l.id !== originId);
  const save = async () => {
    if (!originId || !dest || !selected.size) return;
    const chosen = available.filter(v => selected.has(v.item.id));
    const transferId = uuid();
    await enqueue(db, {accountId: account!.accountId, deviceId: account!.deviceId}, {
      type: 'DISPATCH_TRANSFER',
      aggregate_id: transferId,
      preconditions: chosen.map(v => ({entity: 'equipment' as const, id: v.item.id, expected_version: v.item.version})),
      payload: {from_location_id: originId, to_location_id: dest.id, item_ids: chosen.map(v => v.item.id), note},
      summary: `Dispatch ${chosen.length} item${chosen.length === 1 ? '' : 's'} to ${dest.label}`,
    });
    triggerSync('dispatch');
    navigation.goBack();
  };
  return (
    <Screen title="Dispatch handover" onBack={navigation.goBack}
      footer={
        <>
          <Button testID="save-dispatch" title="Save dispatch" onPress={save} disabled={!dest || !selected.size} />
          <Banner tone="warning">Receipt confirmation is required at the destination, tag by tag.</Banner>
        </>
      }>
      <Field label="From (origin)">
        <Row title={campLocs.find(l => l.id === originId)?.label ?? 'Choose'} left={<MapPin color={colors.text} size={20} />} onPress={() => setSheet('origin')} />
      </Field>
      <Field label="To (destination)" hint={orgLocs ? undefined : 'Destination list needs one online refresh.'}>
        <Row testID="pick-destination" title={dest ? `${dest.label} · ${dest.camp_name}` : 'Choose destination'} left={<MapPin color={colors.text} size={20} />} onPress={() => setSheet('dest')} />
      </Field>
      <View style={{flexDirection: 'row', justifyContent: 'space-between'}}>
        <Text style={type.heading}>Items in this handover</Text>
        <Text style={type.small}>{selected.size} tagged item{selected.size === 1 ? '' : 's'}</Text>
      </View>
      {available.length ? <TagChecklist views={available} selected={selected} toggle={id => {
        const n = new Set(selected);
        if (n.has(id)) n.delete(id); else n.add(id);
        setSelected(n);
      }} /> : <Empty title="No ready items here" body="Only READY items at the origin can be dispatched." />}
      <Field label="Note (optional)"><Input value={note} onChangeText={setNote} placeholder="Vehicle, driver…" maxLength={500} /></Field>
      <Sheet visible={sheet === 'origin'} onClose={() => setSheet(null)} title="Origin">
        {campLocs.map(l => <Row key={l.id} title={l.label} onPress={() => { setOrigin(l.id); setSelected(new Set()); setSheet(null); }} />)}
      </Sheet>
      <Sheet visible={sheet === 'dest'} onClose={() => setSheet(null)} title="Destination">
        {destinations.map(l => <Row key={l.id} testID={`dest-${l.label}`} title={l.label} subtitle={l.camp_name} onPress={() => { setDest(l); setSheet(null); }} />)}
      </Sheet>
    </Screen>
  );
}

function LineRow({itemId, result, onChange}: {itemId: string; result: 'RECEIVED' | 'MISSING' | null; onChange: (r: 'RECEIVED' | 'MISSING') => void}) {
  const item = useItem(itemId) as EquipmentP | null | undefined;
  const v = useItemViews(item ? [item] : undefined)?.[0];
  return (
    <View style={{flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: space.s}}>
      <ItemThumb imageKey={v?.category?.image_key} size={48} />
      <View style={{flex: 1}}>
        <Text style={[type.body, {fontWeight: '700'}]}>{item?.tag ?? 'Unknown tag'}</Text>
        <Text style={type.small}>{v ? itemTitle(v) : ''}</Text>
      </View>
      {(['RECEIVED', 'MISSING'] as const).map(r => (
        <Pressable key={r} testID={`${r.toLowerCase()}-${item?.tag}`} accessibilityRole="radio" accessibilityState={{checked: result === r}}
          onPress={() => onChange(r)}
          style={{minHeight: 44, minWidth: 44, paddingHorizontal: 10, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center',
            backgroundColor: result === r ? (r === 'RECEIVED' ? colors.successBg : colors.errorBg) : colors.neutralBg}}>
          {r === 'RECEIVED' ? <CircleCheck color={result === r ? colors.success : colors.muted} size={22} /> : <CircleAlert color={result === r ? colors.error : colors.muted} size={22} />}
        </Pressable>
      ))}
    </View>
  );
}

export function TransferReceiveScreen({route, navigation}: ScreenProps<'TransferReceive'>) {
  const db = useDb();
  const account = useSession(s => s.account);
  const transfer = useProjection<TransferP>('transfers', Q.where('server_id', route.params.transferId))?.[0];
  const lines = useTransferLines(route.params.transferId);
  const locs = useAllLocations();
  const [results, setResults] = useState<Record<string, 'RECEIVED' | 'MISSING'>>({});
  const [note, setNote] = useState('');
  const [extra, setExtra] = useState('');
  if (!transfer || !lines) return <Screen onBack={navigation.goBack}><Text>Loading…</Text></Screen>;
  const missing = lines.filter(l => results[l.item_id] === 'MISSING').length;
  const received = lines.filter(l => results[l.item_id] === 'RECEIVED').length;
  const complete = lines.every(l => results[l.item_id]);
  const extras = extra.split(/[\s,]+/).map(t => t.trim().toUpperCase()).filter(Boolean);
  const needsNote = missing > 0 || extras.length > 0;
  const save = async () => {
    await enqueue(db, {accountId: account!.accountId, deviceId: account!.deviceId}, {
      type: 'RECEIVE_TRANSFER',
      aggregate_id: transfer.id,
      preconditions: [{entity: 'transfer', id: transfer.id, expected_version: transfer.version}],
      payload: {
        lines: lines.map(l => ({item_id: l.item_id, result: results[l.item_id], note: results[l.item_id] === 'MISSING' ? note : ''})),
        extra_items: extras.map(tag => ({tag, note})),
        notes: note,
      },
      summary: `Receive ${transfer.code}: ${received}/${lines.length}${missing ? ` · ${missing} missing` : ''}`,
    });
    triggerSync('receive');
    navigation.goBack();
  };
  return (
    <Screen title="Receive handover" onBack={navigation.goBack}
      footer={
        <>
          <Button testID="save-receipt" title={missing || extras.length ? 'Save receipt with discrepancy' : 'Save receipt'} onPress={save}
            disabled={!complete || (needsNote && note.trim().length < 3)} />
          <Text style={[type.small, {textAlign: 'center'}]}>Saved receipts sync later if you are offline.</Text>
        </>
      }>
      <Card>
        <Text style={type.heading}>{transfer.code}</Text>
        <Text style={type.small}>From {locs?.find(l => l.id === transfer.from_location_id)?.label ?? 'another camp'} → {locs?.find(l => l.id === transfer.to_location_id)?.label}</Text>
        <Text style={type.small}>Dispatched {formatTime(transfer.dispatched_at)}</Text>
      </Card>
      <View style={{flexDirection: 'row', justifyContent: 'space-between'}}>
        <Text style={type.heading}>Confirm each tag</Text>
        <Text style={type.small}>{lines.length} expected / {received} received</Text>
      </View>
      <View>
        {lines.map(l => <LineRow key={l.id} itemId={l.item_id} result={results[l.item_id] ?? null} onChange={r => setResults({...results, [l.item_id]: r})} />)}
      </View>
      <Button title="Mark all received" variant="secondary" onPress={() => setResults(Object.fromEntries(lines.map(l => [l.item_id, 'RECEIVED'])))} />
      <Field label="Unexpected tags that arrived (optional)" hint="Separate tags with spaces. They are flagged for a supervisor.">
        <Input value={extra} onChangeText={setExtra} autoCapitalize="characters" placeholder="e.g. BPK-016" />
      </Field>
      <Field label={`Discrepancy note${needsNote ? ' *' : ' (optional)'}`} hint={`${note.length}/500`}>
        <Input testID="discrepancy-note" value={note} onChangeText={setNote} multiline maxLength={500} placeholder="What was checked, who was told" />
      </Field>
      {missing ? <Banner tone="warning">Missing items stay blocked and are never marked ready or moved here until a supervisor resolves them.</Banner> : null}
    </Screen>
  );
}
