import React, {useEffect, useMemo, useState} from 'react';
import {FlatList, Image, Pressable, ScrollView, Text, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {Calendar, MapPin, Search, ScanLine} from 'lucide-react-native';
import {STATUS_LABEL, SYNC_LABEL, type EquipmentStatus} from '@trailops/contracts';
import type {RootStack, ScreenProps, Tabs} from '../../app/navigation';
import {can, useSession} from '../../app/session';
import {
  useActiveAllocation, useAllMembers, useCampEquipment, useItem, useItemInspections, useItemRepairs, useOpenClaims,
} from '../../database/hooks';
import {Banner, Button, Divider, Empty, Input, ItemThumb, KeyValue, Pill, Row, Screen, StatusPill} from '../../ui/components';
import {categoryImages, colors, radius, space, type} from '../../ui/tokens';
import {formatDay, formatTime} from '../../ui/format';
import {itemTitle, provisionalIssue, useItemViews, type ItemView, type Overlay} from './model';

const FILTERS: {key: string; label: string; statuses: EquipmentStatus[]}[] = [
  {key: 'READY', label: 'Available', statuses: ['READY']},
  {key: 'ISSUED', label: 'Issued', statuses: ['ISSUED']},
  {key: 'REPAIR', label: 'Repair', statuses: ['QUARANTINED', 'REPAIR_PENDING', 'UNDER_REPAIR']},
  {key: 'OTHER', label: 'Other', statuses: ['IN_TRANSIT', 'MISSING', 'RETIRED']},
];

function useDebounced<T>(value: T, ms = 200): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function overlayLabel(o: Overlay): {label: string; tone: 'warning' | 'error' | 'info'} {
  switch (o.kind) {
    case 'provisional-issue':
      return {label: `Provisional issue · ${SYNC_LABEL.awaiting.toLowerCase()}`, tone: 'warning'};
    case 'provisional-return':
      return {label: `Return saved on device · ${SYNC_LABEL.awaiting.toLowerCase()}`, tone: 'warning'};
    case 'blocked':
      return {label: SYNC_LABEL.review, tone: 'error'};
    default:
      return {label: SYNC_LABEL.saved, tone: 'info'};
  }
}

export function EquipmentListScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStack>>();
  const route = useRoute<RouteProp<Tabs, 'Equipment'>>();
  const campId = useSession(s => s.campId);
  const items = useCampEquipment(campId);
  const views = useItemViews(items);
  const [filter, setFilter] = useState(route.params?.status === 'ISSUED' ? 'ISSUED' : 'READY');
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim().toLowerCase());
  useEffect(() => {
    if (route.params?.status) setFilter(route.params.status === 'ISSUED' ? 'ISSUED' : 'READY');
  }, [route.params?.status]);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const f of FILTERS) m[f.key] = (views ?? []).filter(v => f.statuses.includes(v.item.status)).length;
    return m;
  }, [views]);
  const shown = useMemo(() => {
    const f = FILTERS.find(x => x.key === filter)!;
    return (views ?? []).filter(v => {
      // A search matches across all statuses so a typed tag is always found.
      if (dq) return v.item.tag.toLowerCase().includes(dq) || itemTitle(v).toLowerCase().includes(dq);
      return f.statuses.includes(v.item.status);
    });
  }, [views, filter, dq]);

  return (
    <SafeAreaView style={{flex: 1, backgroundColor: colors.surface}} edges={['top', 'left', 'right']}>
      <View style={{padding: space.l, gap: space.m}}>
        <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'}}>
          <Text style={type.title} accessibilityRole="header">Equipment</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Scan equipment" onPress={() => nav.navigate('Scan')}
            style={{width: 48, height: 48, alignItems: 'center', justifyContent: 'center'}}>
            <ScanLine color={colors.text} size={26} />
          </Pressable>
        </View>
        <View style={{justifyContent: 'center'}}>
          <Input testID="equipment-search" value={q} onChangeText={setQ} placeholder="Search gear or tag (e.g. JKT-014)"
            style={{paddingLeft: 42}} autoCapitalize="characters" accessibilityLabel="Search gear or tag" />
          <View style={{position: 'absolute', left: 12}} pointerEvents="none"><Search color={colors.muted} size={20} /></View>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{gap: space.s}}>
          {FILTERS.map(f => (
            <Pressable key={f.key} onPress={() => setFilter(f.key)} accessibilityRole="button"
              accessibilityState={{selected: filter === f.key}}
              style={{paddingHorizontal: 16, minHeight: 44, justifyContent: 'center', borderRadius: radius.button,
                backgroundColor: filter === f.key && !dq ? colors.primary : colors.neutralBg}}>
              <Text style={{fontWeight: '600', color: colors.text}}>{f.label} ({counts[f.key] ?? 0})</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
      <FlatList
        data={shown}
        keyExtractor={v => v.item.id}
        contentContainerStyle={{paddingHorizontal: space.l, paddingBottom: space.xxl}}
        ItemSeparatorComponent={Divider}
        initialNumToRender={20}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={views ? <Empty title="Nothing here" body={dq ? 'No downloaded item matches that search.' : 'No items in this status at this camp.'} /> : null}
        renderItem={({item: v}) => <ItemRow v={v} onPress={() => nav.navigate('EquipmentDetail', {itemId: v.item.id})} />}
      />
    </SafeAreaView>
  );
}

/** A row is one tagged asset, never a category summary (spec §11). */
function ItemRow({v, onPress}: {v: ItemView; onPress: () => void}) {
  const o = v.overlays[v.overlays.length - 1];
  return (
    <Row testID={`item-${v.item.tag}`} accessibilityLabel={`${itemTitle(v)} ${v.item.tag}`}
      title={itemTitle(v)} subtitle={`${v.item.tag}${v.item.size ? ` · ${v.item.size}` : ''}`}
      left={<ItemThumb imageKey={v.category?.image_key} size={68} />}
      right={
        <View style={{alignItems: 'flex-end', gap: 4, maxWidth: 140}}>
          <StatusPill status={v.item.status} />
          {o ? <Pill label={overlayLabel(o).label.split(' · ')[0]} tone={overlayLabel(o).tone} /> : null}
        </View>
      }
      onPress={onPress} />
  );
}

export function EquipmentDetailScreen({route, navigation}: ScreenProps<'EquipmentDetail'>) {
  const item = useItem(route.params.itemId);
  const views = useItemViews(item ? [item] : undefined);
  const v = views?.[0];
  const me = useSession(s => s.me);
  const allocation = useActiveAllocation(item?.id);
  const members = useAllMembers();
  const inspections = useItemInspections(item?.id);
  const repairs = useItemRepairs(item?.id);
  const claims = useOpenClaims(item?.id);

  if (item === null) {
    return <Screen onBack={navigation.goBack}><Empty title="Not downloaded for this camp" body="This item is not part of the data on this device." /></Screen>;
  }
  if (!item || !v) return <Screen onBack={navigation.goBack}><Text>Loading…</Text></Screen>;

  const recipient = allocation ? members?.find(m => m.trekker_id === allocation.trekker_id) : null;
  const provisional = provisionalIssue(v);
  const lastInspection = [...(inspections ?? [])].sort((a, b) => b.submitted_at.localeCompare(a.submitted_at))[0];
  const openRepair = (repairs ?? []).find(r => !['CLOSED', 'DENIED'].includes(r.state));
  const s = STATUS_LABEL[item.status];
  const canIssue = s.issuable && !v.locallyBusy && (claims?.length ?? 0) === 0 && can(me, 'issue.create');
  const canReturn = (allocation || provisional) && !v.overlays.some(o => o.kind === 'provisional-return') && can(me, 'return.submit');
  const history = [
    ...(inspections ?? []).map(i => ({at: i.submitted_at, title: i.kind === 'RELEASE' ? 'Released after inspection' : `Returned · ${i.condition.replace('_', ' ').toLowerCase()}`, sub: i.evidence_state === 'PENDING' ? 'Photos pending upload' : null})),
    ...(repairs ?? []).map(r => ({at: r.updated_at, title: `Repair ${r.state.replace(/_/g, ' ').toLowerCase()}`, sub: r.decision_note})),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6);

  return (
    <Screen onBack={navigation.goBack}
      footer={
        <>
          {canIssue ? <Button testID="issue-to-trekker" title="Issue to trekker" onPress={() => navigation.navigate('IssueGear', {itemId: item.id})} /> : null}
          {canReturn ? <Button testID="return-item" title="Return & inspect" variant={canIssue ? 'secondary' : 'primary'} onPress={() => navigation.navigate('ReturnInspection', {itemId: item.id})} /> : null}
        </>
      }>
      {v.category?.image_key && categoryImages[v.category.image_key] ? (
        <Image source={categoryImages[v.category.image_key]} style={{width: '100%', height: 220, borderRadius: 12}} resizeMode="contain" accessibilityIgnoresInvertColors />
      ) : null}
      <View style={{gap: 4}}>
        <Text style={type.title}>{itemTitle(v)}</Text>
        <Text style={[type.body, {color: colors.muted}]}>{item.tag}{item.size ? ` · Size ${item.size}` : ''}</Text>
      </View>
      <View style={{flexDirection: 'row', gap: space.s, flexWrap: 'wrap'}}>
        <StatusPill status={item.status} />
        {v.overlays.map(o => <Pill key={o.op.operation_id} label={overlayLabel(o).label} tone={overlayLabel(o).tone} />)}
      </View>
      {provisional ? (
        <Banner tone="warning" title={SYNC_LABEL.saved}>
          {`Issued to ${provisional.trekkerName} on this device. The server has not confirmed it yet; the confirmed status above is unchanged.`}
        </Banner>
      ) : null}
      {(claims?.length ?? 0) > 0 ? (
        <Banner tone="error" title="Custody needs reconciling">{claims![0].description}</Banner>
      ) : null}
      {openRepair ? <Banner tone="warning" title="Unavailable until repair is released">{`Repair: ${openRepair.state.replace(/_/g, ' ').toLowerCase()}`}</Banner> : null}
      <View>
        <KeyValue icon={<MapPin color={colors.text} size={18} />} k="Location" v={v.location?.label ?? '—'} />
        {allocation ? <KeyValue k="Issued to" v={`${recipient?.display_name ?? 'Trekker'} · due ${formatDay(allocation.due_date)}`} /> : null}
        <KeyValue icon={<Calendar color={colors.text} size={18} />} k="Last inspected" v={item.last_inspected_at ? formatTime(item.last_inspected_at) : 'Not yet'} />
        {lastInspection ? <KeyValue k="Last condition" v={`${lastInspection.condition.replace('_', ' ').toLowerCase()}${lastInspection.evidence_state === 'PENDING' ? ' · photos pending' : ''}`} /> : null}
      </View>
      <Divider />
      <Text style={type.heading}>Recent history</Text>
      {history.length ? history.map((h, i) => (
        <View key={i} style={{flexDirection: 'row', gap: space.m}}>
          <View style={{width: 10, height: 10, borderRadius: 5, marginTop: 6, backgroundColor: i === 0 ? colors.success : colors.divider}} />
          <View style={{flex: 1}}>
            <Text style={type.body}>{h.title}</Text>
            {h.sub ? <Text style={type.small}>{h.sub}</Text> : null}
          </View>
          <Text style={type.small}>{formatDay(h.at)}</Text>
        </View>
      )) : <Text style={type.small}>No inspections or repairs recorded on this device.</Text>}
      <Text style={type.small}>Gear photos are illustrative category images, not photos of this asset.</Text>
    </Screen>
  );
}
