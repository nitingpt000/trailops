/**
 * Repair review (spec §15). Supervisors can review on the phone, but approval is an online-only
 * command (spec §4): it is sent immediately through /v1/commands, never queued.
 */
import React, {useState} from 'react';
import {Image, Text, View} from 'react-native';
import {Calendar, Camera, FileText, User, Wrench} from 'lucide-react-native';
import {REPAIR_LABEL, type Receipt, type RepairP} from '@trailops/contracts';
import type {ScreenProps} from '../../app/navigation';
import {can, useSession} from '../../app/session';
import {triggerSync} from '../../app/startup';
import {useItem, useItemInspections, useRepairsByState} from '../../database/hooks';
import {useSync} from '../../sync/coordinator';
import {HttpError, NetworkError, api} from '../../sync/api';
import {uuid} from '../../native/sha256';
import {Banner, Button, Card, Divider, Empty, Field, Input, ItemThumb, KeyValue, Row, Screen} from '../../ui/components';
import {colors, space, type} from '../../ui/tokens';
import {formatDay} from '../../ui/format';
import {itemTitle, useItemViews} from '../equipment/model';

function RepairDetail({repair, onDone}: {repair: RepairP; onDone: () => void}) {
  const {account, me} = useSession();
  const online = useSync(s => s.online);
  const item = useItem(repair.item_id);
  const v = useItemViews(item ? [item] : undefined)?.[0];
  const insp = (useItemInspections(repair.item_id) ?? []).find(i => i.id === repair.inspection_id);
  const [note, setNote] = useState('');
  const [result, setResult] = useState<{tone: 'success' | 'error' | 'warning'; text: string} | null>(null);
  const [opId] = useState(uuid); // one durable operation id per submission; reused on retry
  const evidenceOk = !insp || insp.evidence_state === 'VERIFIED' || insp.evidence_state === 'NOT_REQUIRED';

  const decide = async (decision: 'APPROVE' | 'MORE_INFORMATION') => {
    setResult(null);
    try {
      const r = await api<Receipt>({accountId: account!.accountId}, 'POST', '/v1/commands', {
        operation_id: opId, type: 'APPROVE_REPAIR', aggregate_id: repair.id, expected_version: repair.version,
        preconditions: [{entity: 'repair', id: repair.id, expected_version: repair.version}],
        payload: {decision, note},
      });
      setResult({tone: 'success', text: decision === 'APPROVE' ? 'Repair approved.' : 'More information requested.'});
      triggerSync('repair-decision');
      if (r.status === 'ACCEPTED') setTimeout(onDone, 800);
    } catch (e) {
      if (e instanceof NetworkError) setResult({tone: 'warning', text: 'No connection. Approval is only possible online.'});
      else if (e instanceof HttpError) setResult({tone: 'error', text: (e.body as unknown as Receipt)?.message ?? e.message});
      else setResult({tone: 'error', text: String(e)});
    }
  };

  return (
    <>
      <Card style={{flexDirection: 'row', gap: space.m, alignItems: 'center'}}>
        <ItemThumb imageKey={v?.category?.image_key} size={84} />
        <View style={{flex: 1}}>
          <Text style={type.heading}>{v ? itemTitle(v) : 'Equipment'}</Text>
          <Text style={type.body}>{item?.tag}{item?.size ? ` · Size ${item.size}` : ''}</Text>
          <Text style={type.small}>{REPAIR_LABEL[repair.state]}{repair.kind === 'DISPOSITION' ? ' · retirement decision' : ''}</Text>
        </View>
      </Card>
      {insp?.issue_type === 'BROKEN_ZIP' ? (
        <Image source={require('../../../assets/images/damaged-zip-detail.png')} style={{width: '100%', height: 120, borderRadius: 12}}
          resizeMode="cover" accessibilityLabel="Illustrative example of a broken zip (not this item's evidence)" />
      ) : null}
      <View>
        <KeyValue icon={<Calendar color={colors.text} size={18} />} k="Reported on" v={formatDay(insp?.submitted_at ?? repair.created_at)} />
        <KeyValue icon={<Wrench color={colors.text} size={18} />} k="Issue type" v={(insp?.issue_type ?? '—').replace(/_/g, ' ').toLowerCase()} />
        <KeyValue icon={<FileText color={colors.text} size={18} />} k="Inspection notes" v={insp?.notes ?? '—'} />
        <KeyValue icon={<Camera color={colors.text} size={18} />} k="Photos" v={insp ? insp.evidence_state.replace('_', ' ').toLowerCase() : '—'} />
        <KeyValue icon={<User color={colors.text} size={18} />} k="Condition" v={insp?.condition.replace('_', ' ').toLowerCase() ?? '—'} />
      </View>
      <Banner tone="warning">Item stays unavailable until repair is completed and released.</Banner>
      {!evidenceOk ? <Banner tone="error" title="Evidence not verified">Approval is blocked until the inspection photos upload and pass verification.</Banner> : null}
      {online === false ? <Banner tone="warning">Approval needs a connection. Review now, approve when online.</Banner> : null}
      {result ? <Banner tone={result.tone}>{result.text}</Banner> : null}
      {can(me, 'repair.approve') && ['REQUESTED', 'MORE_INFORMATION_REQUIRED'].includes(repair.state) ? (
        <>
          <Field label="Note (required to request details)"><Input value={note} onChangeText={setNote} multiline maxLength={1000} /></Field>
          <Button testID="approve-repair" title={repair.kind === 'DISPOSITION' ? 'Approve retirement' : 'Approve repair'} disabled={!evidenceOk || online === false}
            onPress={() => decide('APPROVE')} />
          <Button title="Request more details" variant="secondary" disabled={note.trim().length < 3 || online === false}
            onPress={() => decide('MORE_INFORMATION')} />
          <Text style={type.small}>Denial, work completion and release are done in the console.</Text>
        </>
      ) : null}
    </>
  );
}

export function RepairReviewScreen({route, navigation}: ScreenProps<'RepairReview'>) {
  const repairs = useRepairsByState(['REQUESTED', 'MORE_INFORMATION_REQUIRED', 'APPROVED', 'IN_PROGRESS', 'AWAITING_RELEASE']);
  const [selected, setSelected] = useState<string | null>(route.params?.repairId ?? null);
  const repair = repairs?.find(r => r.id === selected);
  if (repair) {
    return (
      <Screen title="Review repair request" subtitle="Check details and approve" onBack={() => setSelected(null)}>
        <RepairDetail repair={repair} onDone={() => setSelected(null)} />
      </Screen>
    );
  }
  return (
    <Screen title="Repairs" onBack={navigation.goBack}>
      {repairs?.length ? repairs.map((r, i) => (
        <React.Fragment key={r.id}>
          {i ? <Divider /> : null}
          <RepairRow r={r} onPress={() => setSelected(r.id)} />
        </React.Fragment>
      )) : <Empty title="No open repairs" body="Damaged returns appear here after they sync." />}
    </Screen>
  );
}

function RepairRow({r, onPress}: {r: RepairP; onPress: () => void}) {
  const item = useItem(r.item_id);
  return <Row title={item?.tag ?? 'Item'} subtitle={REPAIR_LABEL[r.state]} onPress={onPress} />;
}
