import React, {useState} from 'react';
import {Alert, Text} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {LogOut, MapPin, RefreshCw, Settings as SettingsIcon, Wrench} from 'lucide-react-native';
import type {RootStack, ScreenProps} from '../../app/navigation';
import {can, useSession} from '../../app/session';
import {pendingCount, signInAndLoad} from '../../app/startup';
import {forgetCredentials, writeAccount} from '../../auth/session';
import {closeDatabase} from '../../database';
import {useSync} from '../../sync/coordinator';
import {Banner, Button, Card, Divider, KeyValue, Row, Screen} from '../../ui/components';
import {colors, type} from '../../ui/tokens';
import {CampSelectScreen} from '../signin/SignInScreens';

export function MoreScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStack>>();
  const me = useSession(s => s.me);
  return (
    <Screen title="More">
      <Row title="Sync centre" subtitle="Saved changes, uploads and exceptions" left={<RefreshCw color={colors.text} size={22} />} onPress={() => nav.navigate('SyncCentre')} />
      <Divider />
      {can(me, 'repair.approve') ? (
        <>
          <Row testID="open-repairs" title="Repairs" subtitle="Review repair requests" left={<Wrench color={colors.text} size={22} />} onPress={() => nav.navigate('RepairReview')} />
          <Divider />
        </>
      ) : null}
      <Row title="Account & camp" subtitle={me?.user.display_name} left={<SettingsIcon color={colors.text} size={22} />} onPress={() => nav.navigate('Settings')} />
      <Text style={[type.small, {marginTop: 24}]}>TrailOps · Independent applicant concept · Sample data. Not an official Indiahikes application.</Text>
    </Screen>
  );
}

export function SettingsScreen({navigation}: ScreenProps<'Settings'>) {
  const {me, campId, account} = useSession();
  const authBlocked = useSync(s => s.authBlocked);
  const [switching, setSwitching] = useState(false);
  if (switching) return <CampSelectScreen onDone={() => setSwitching(false)} />;
  const camp = me?.camps.find(c => c.id === campId);
  return (
    <Screen title="Account" onBack={navigation.goBack}>
      <Card>
        <KeyValue k="Name" v={me?.user.display_name ?? account?.displayName ?? '—'} />
        <KeyValue k="Role" v={(me?.role ?? '—').replace('_', ' ')} />
        <KeyValue k="Camp" v={camp?.name ?? '—'} />
        <KeyValue k="Device" v={account?.deviceId ? account.deviceId.slice(0, 8) : 'Not registered yet'} />
      </Card>
      {authBlocked ? <Button title="Sign in again" onPress={signInAndLoad} /> : null}
      {(me?.camps.length ?? 0) > 1 ? <Button title="Switch camp" variant="secondary" icon={<MapPin color={colors.text} size={20} />} onPress={() => setSwitching(true)} /> : null}
      <Banner tone="info">Signing out removes this device's credentials. It is blocked while changes are waiting, so no work is silently lost.</Banner>
      <Button testID="sign-out" title="Sign out" variant="danger" icon={<LogOut color={colors.error} size={20} />} onPress={async () => {
        const n = await pendingCount();
        if (n > 0) {
          Alert.alert('Changes not yet synced', `${n} change(s) are still on this device. Sync them before signing out, or ask a supervisor for a recovery export.`);
          return;
        }
        await forgetCredentials(account!.accountId);
        await writeAccount({...account!, lastVerifiedAt: null});
        closeDatabase();
        useSession.getState().set({phase: 'signedOut', db: null, me: null, campId: null});
      }} />
    </Screen>
  );
}
