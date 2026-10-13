/**
 * Sync centre (spec §18): what is saved on this device, what the server confirmed, what needs review.
 * Accepted/rejected receipts stay visible for the retention window.
 */
import React from 'react';
import {Text, View} from 'react-native';
import {ArrowUp, CircleAlert, CircleCheck, Clock, Image as ImageIcon, RefreshCw, Wifi, WifiOff} from 'lucide-react-native';
import {SYNC_LABEL} from '@trailops/contracts';
import type {ScreenProps} from '../../app/navigation';
import {useSession} from '../../app/session';
import {triggerSync} from '../../app/startup';
import {useAttachmentQueue, useMeta, useOpenConflicts, useQueue} from '../../database/hooks';
import type {QueueRow} from '../../database/models';
import {useSync} from '../../sync/coordinator';
import {Banner, Button, Card, Divider, KeyValue, Pill, Row, Screen} from '../../ui/components';
import {colors, space, type} from '../../ui/tokens';
import {formatTime} from '../../ui/format';

export function stateLabel(q: QueueRow): {label: string; tone: 'warning' | 'error' | 'success' | 'info' | 'neutral'} {
  switch (q.state) {
    case 'ACCEPTED':
      return {label: SYNC_LABEL.confirmed, tone: 'success'};
    case 'CONFLICT':
    case 'REJECTED':
      return {label: SYNC_LABEL.review, tone: 'error'};
    case 'AUTH_BLOCKED':
      return {label: 'Sign in to send', tone: 'error'};
    case 'DEPENDENCY_WAIT':
      return q.error_code === 'BLOCKED_BY_DEPENDENCY' ? {label: SYNC_LABEL.review, tone: 'error'} : {label: 'Waiting for earlier change', tone: 'warning'};
    case 'SENDING':
      return {label: 'Sending…', tone: 'info'};
    case 'RETRY_WAIT':
      return {label: 'Will retry', tone: 'warning'};
    default:
      return {label: SYNC_LABEL.saved, tone: 'warning'};
  }
}

export function SyncCentreScreen({navigation}: ScreenProps<'SyncCentre'>) {
  const {online, running, phase, lastError, authBlocked} = useSync();
  const queue = useQueue() ?? [];
  const atts = useAttachmentQueue() ?? [];
  const meta = useMeta();
  const conflicts = useOpenConflicts() ?? [];
  const pending = queue.filter(q => !['ACCEPTED', 'CONFLICT', 'REJECTED'].includes(q.state));
  const review = queue.filter(q => ['CONFLICT', 'REJECTED'].includes(q.state) || q.error_code === 'BLOCKED_BY_DEPENDENCY');
  const done = queue.filter(q => q.state === 'ACCEPTED').slice(0, 10);
  const photoPending = atts.filter(a => !['VERIFIED', 'REJECTED'].includes(a.state));

  return (
    <Screen title="Sync centre" onBack={navigation.goBack}
      footer={<Button testID="sync-now" title={running ? (phase ?? 'Syncing…') : online === false ? 'Try to sync now' : 'Sync now'} disabled={running}
        icon={<RefreshCw color={colors.text} size={20} />} onPress={() => triggerSync('manual')} />}>
      {online === false ? (
        <Banner tone="warning" icon={<WifiOff color={colors.warning} size={20} />} title={`Offline · ${pending.length} change${pending.length === 1 ? '' : 's'} saved on device`}>
          Your work is stored on this device. It syncs automatically when you are back online.
        </Banner>
      ) : (
        <Banner tone="success" icon={<Wifi color={colors.success} size={20} />} title="Connected">
          {pending.length ? `${pending.length} change(s) waiting to send.` : 'Nothing waiting to send.'}
        </Banner>
      )}
      {authBlocked ? <Banner tone="error" title="Sign-in required">Your session ended. Pending work is kept; sign in again from Settings to send it.</Banner> : null}
      {lastError && online !== false ? <Banner tone="error">{lastError}</Banner> : null}
      <Card>
        <KeyValue icon={<Clock color={colors.text} size={18} />} k="Last synced" v={formatTime(meta?.last_success_at)} />
        <KeyValue k="Data downloaded" v={formatTime(meta?.last_pull_at)} />
      </Card>

      {review.length || conflicts.length ? <Text style={type.heading}>Needs review ({review.length})</Text> : null}
      {review.map(q => (
        <Row key={q.operation_id} testID={`review-${q.type}`} title={q.summary} subtitle={q.error_message ?? q.error_code ?? ''}
          left={<CircleAlert color={colors.error} size={26} />}
          onPress={() => navigation.navigate('OperationDetail', {operationId: q.operation_id})} />
      ))}

      <Text style={type.heading}>Pending changes ({pending.length})</Text>
      {pending.length ? pending.map(q => (
        <Row key={q.operation_id} title={q.summary} subtitle={`Recorded ${formatTime(q.client_recorded_at)}${q.attempts ? ` · ${q.attempts} attempt(s)` : ''}`}
          left={<ArrowUp color={colors.warning} size={26} />} right={<Pill {...stateLabel(q)} />}
          onPress={() => navigation.navigate('OperationDetail', {operationId: q.operation_id})} />
      )) : <Text style={type.small}>Nothing waiting.</Text>}

      {photoPending.length ? (
        <>
          <Text style={type.heading}>Photos ({photoPending.length})</Text>
          {photoPending.map(a => (
            <Row key={a.attachment_id} title="Pending photo attachment" subtitle={a.state === 'WAITING_PARENT' ? 'Uploads after the inspection is accepted' : a.error ?? a.state.toLowerCase()}
              left={<ImageIcon color={colors.info} size={26} />} />
          ))}
        </>
      ) : null}

      {done.length ? <><Divider /><Text style={type.heading}>Recently confirmed</Text></> : null}
      {done.map(q => (
        <Row key={q.operation_id} title={q.summary} subtitle={formatTime(q.client_recorded_at)} left={<CircleCheck color={colors.success} size={22} />}
          onPress={() => navigation.navigate('OperationDetail', {operationId: q.operation_id})} />
      ))}
    </Screen>
  );
}

export function OperationDetailScreen({route, navigation}: ScreenProps<'OperationDetail'>) {
  const q = (useQueue() ?? []).find(x => x.operation_id === route.params.operationId);
  const conflicts = useOpenConflicts() ?? [];
  const role = useSession(s => s.me?.role);
  if (!q) return <Screen onBack={navigation.goBack}><Text>Not found.</Text></Screen>;
  const result = q.result_json ? JSON.parse(q.result_json) : null;
  const conflict = conflicts.find(c => c.operation_id === q.operation_id);
  const s = stateLabel(q);
  return (
    <Screen title={q.summary} onBack={navigation.goBack}>
      <Pill {...s} />
      {q.error_message ? <Banner tone={s.tone === 'error' ? 'error' : 'warning'} title={q.error_code ?? undefined}>{q.error_message}</Banner> : null}
      {result?.field_errors ? (
        <Card>{Object.entries(result.field_errors as Record<string, string>).map(([k, v]) => <KeyValue key={k} k={k} v={v} />)}</Card>
      ) : null}
      {conflict ? <Button testID="open-conflict" title="Resolve allocation conflict" onPress={() => navigation.navigate('ConflictDetail', {conflictId: conflict.id})} /> : null}
      {q.state === 'REJECTED' ? (
        <Banner tone="info">
          {"This record is kept on the device for supervised recovery. Correct the situation and create a new action; the original is never resent with different content."}
        </Banner>
      ) : null}
      <Card>
        <KeyValue k="Operation" v={q.operation_id.slice(0, 8)} />
        <KeyValue k="Type" v={q.type} />
        <KeyValue k="Recorded" v={formatTime(q.client_recorded_at)} />
        <KeyValue k="Attempts" v={String(q.attempts)} />
        {role ? <KeyValue k="Your role" v={role.replace('_', ' ')} /> : null}
      </Card>
      <View style={{height: space.l}} />
    </Screen>
  );
}
