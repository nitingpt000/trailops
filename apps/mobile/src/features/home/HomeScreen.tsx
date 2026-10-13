/**
 * Camp home (spec §10). Built only from downloaded projections plus pending overlays. Counts that are
 * local-only are labelled as such; nothing here waits for the network.
 */
import React, {useMemo} from 'react';
import {Image, Pressable, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {CircleAlert, MapPin, PackageCheck, ScanLine, Users, ClipboardCheck, UserCircle} from 'lucide-react-native';
import {useSession} from '../../app/session';
import type {RootStack} from '../../app/navigation';
import {
  useCampBatches, useCampEquipment, useCampLocations, useMeta, useNeedsReview, useOpenConflicts, usePending, useProjection,
} from '../../database/hooks';
import {Q} from '@nozbe/watermelondb';
import type {AllocationP, BatchMemberP, TransferP} from '@trailops/contracts';
import {Button, Divider, OfflineStrip, Row, Screen} from '../../ui/components';
import {colors, space, type} from '../../ui/tokens';
import {useSync} from '../../sync/coordinator';
import {Wordmark} from '../signin/SignInScreens';
import {formatDay, freshness, todayIso} from '../../ui/format';

function greeting(now = new Date()) {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export function HomeScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStack>>();
  const {me, campId} = useSession();
  const camp = me?.camps.find(c => c.id === campId);
  const online = useSync(s => s.online);
  const pending = usePending();
  const meta = useMeta();
  const batches = useCampBatches(campId);
  const items = useCampEquipment(campId);
  const locations = useCampLocations(campId);
  const conflicts = useOpenConflicts();
  const review = useNeedsReview();
  const today = todayIso();
  const activeBatchIds = (batches ?? []).filter(b => b.active && b.end_date >= today).map(b => b.id);
  const members = useProjection<BatchMemberP>('batch_members', Q.where('batch_id', Q.oneOf(activeBatchIds)));
  const allocations = useProjection<AllocationP>('allocations', Q.where('state', 'ACTIVE'));
  const incoming = useProjection<TransferP>('transfers', Q.where('state', 'DISPATCHED'));

  const tasks = useMemo(() => {
    const allocatedTrekkers = new Set((allocations ?? []).map(a => a.trekker_id));
    const pendingIssueTrekkers = new Set(
      (pending ?? []).filter(p => p.type === 'ISSUE_GEAR').map(p => JSON.parse(p.payload_json).trekker_id),
    );
    const waiting = (members ?? []).filter(m => m.active && !allocatedTrekkers.has(m.trekker_id) && !pendingIssueTrekkers.has(m.trekker_id));
    const locIds = new Set((locations ?? []).map(l => l.id));
    const toReceive = (incoming ?? []).filter(t => locIds.has(t.to_location_id));
    const pendingReturns = new Set((pending ?? []).filter(p => p.type === 'SUBMIT_RETURN').map(p => p.aggregate_id));
    const dueBack = (allocations ?? []).filter(a => a.due_date <= today && !pendingReturns.has(a.item_id));
    const quarantined = (items ?? []).filter(i => i.status === 'QUARANTINED');
    return {waiting, toReceive, dueBack, quarantined};
  }, [allocations, pending, members, locations, incoming, items, today]);

  const reviewOps = new Set(review.map(r => r.operation_id));
  // Open server conflicts raised by this device's operations are already counted via their operation.
  const exceptions = review.length + (conflicts ?? []).filter(c => !reviewOps.has(c.operation_id)).length;

  return (
    <Screen>
      <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'}}>
        <Wordmark />
        <Pressable accessibilityRole="button" accessibilityLabel="Account and settings" onPress={() => nav.navigate('Settings')}>
          <UserCircle color={colors.text} size={34} />
        </Pressable>
      </View>
      <View style={{gap: 4}}>
        <Text style={type.title} accessibilityRole="header">{greeting()}, {me?.user.display_name.split(' ')[0] ?? ''}</Text>
        <View style={{flexDirection: 'row', alignItems: 'center', gap: 6}}>
          <MapPin color={colors.text} size={18} />
          <Text style={type.body}>{camp?.name ?? 'No camp selected'}</Text>
        </View>
      </View>
      <Image source={require('../../../assets/images/camp-mountain-banner.png')}
        style={{width: '100%', height: 170, borderRadius: 12}} resizeMode="cover" accessibilityIgnoresInvertColors />
      <OfflineStrip online={online !== false} pending={pending?.length ?? 0} onPress={() => nav.navigate('SyncCentre')} />
      <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline'}}>
        <Text style={type.heading}>Today</Text>
        <Text style={type.small}>{formatDay(today)} · data {freshness(meta?.last_pull_at)}</Text>
      </View>
      <View>
        <Row title="Issue gear" subtitle={`${tasks.waiting.length} trekkers without gear on device records`}
          left={<Badge><Users color={colors.text} size={22} /></Badge>}
          onPress={() => nav.navigate('MainTabs', {screen: 'Equipment', params: {status: 'READY'}} as never)} />
        <Divider />
        <Row title="Receive handover" subtitle={`${tasks.toReceive.length} handover${tasks.toReceive.length === 1 ? '' : 's'} arriving`}
          left={<Badge tone="neutral"><PackageCheck color={colors.text} size={22} /></Badge>}
          onPress={() => nav.navigate('MainTabs', {screen: 'Transfers'} as never)} />
        <Divider />
        <Row title="Inspect returns" subtitle={`${tasks.dueBack.length} due back · ${tasks.quarantined.length} awaiting release`}
          left={<Badge tone="neutral"><ClipboardCheck color={colors.text} size={22} /></Badge>}
          onPress={() => nav.navigate('MainTabs', {screen: 'Equipment', params: {status: 'ISSUED'}} as never)} />
        {exceptions > 0 ? (
          <>
            <Divider />
            <Row title="Sync exceptions" subtitle={`${exceptions} need review`}
              left={<Badge tone="error"><CircleAlert color={colors.error} size={22} /></Badge>}
              onPress={() => nav.navigate('SyncCentre')} testID="home-exceptions" />
          </>
        ) : null}
      </View>
      <Text style={type.small}>Counts are from this device's downloaded data and saved changes, not live central totals.</Text>
      <Button testID="scan-equipment" title="Scan equipment" icon={<ScanLine color={colors.text} size={24} />}
        onPress={() => nav.navigate('Scan')} />
    </Screen>
  );
}

function Badge({children, tone = 'primary'}: {children: React.ReactNode; tone?: 'primary' | 'neutral' | 'error'}) {
  const bg = tone === 'primary' ? colors.primary : tone === 'error' ? colors.errorBg : colors.neutralBg;
  return <View style={{width: 52, height: 52, borderRadius: 26, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', marginRight: space.xs}}>{children}</View>;
}
