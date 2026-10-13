import React, {useState} from 'react';
import {Image, ImageBackground, StyleSheet, Text, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {LockKeyhole} from 'lucide-react-native';
import {Banner, Button} from '../../ui/components';
import {colors, fonts, space, type} from '../../ui/tokens';
import {signInAndLoad, startup, chooseCamp} from '../../app/startup';
import {useSession} from '../../app/session';
import {useSync} from '../../sync/coordinator';

export function Wordmark({light}: {light?: boolean}) {
  return (
    <View accessibilityLabel="TrailOps, Indiahikes concept">
      <Text style={[styles.word, light && {color: '#fff'}]}>
        Trail<Text style={{color: colors.primary}}>Ops</Text>
      </Text>
      <Text style={[styles.concept, light && {color: '#fff'}]}>Indiahikes concept</Text>
    </View>
  );
}

/** Transient branding only: not a timer and not a network wait (spec §9). */
export function SplashScreen() {
  return (
    <ImageBackground source={require('../../../assets/images/splash-himalayan-camp.png')} style={{flex: 1}} resizeMode="cover">
      <SafeAreaView style={{padding: space.xl}}>
        <Wordmark light />
      </SafeAreaView>
    </ImageBackground>
  );
}

export function SignInScreen() {
  const [error, setError] = useState<string | null>(null);
  return (
    <SafeAreaView style={{flex: 1, backgroundColor: colors.surface}} edges={['bottom']}>
      <ImageBackground source={require('../../../assets/images/welcome-mountains.png')} style={styles.hero} resizeMode="cover">
        <SafeAreaView edges={['top']} style={{padding: space.l}}>
          <Wordmark />
        </SafeAreaView>
      </ImageBackground>
      <View style={styles.body}>
        <Text style={styles.headline} accessibilityRole="header">Built for{'\n'}the mountains.</Text>
        <Text style={[type.body, {color: colors.muted}]}>Camp operations. Even without a signal.</Text>
        {error ? <Banner tone="error" title="Could not sign in">{error}</Banner> : null}
        <Button
          testID="sign-in"
          title="Sign in with work account"
          onPress={async () => {
            setError(null);
            try {
              await signInAndLoad();
            } catch (e) {
              const msg = String((e as Error)?.message ?? e);
              if (!/cancel/i.test(msg)) setError(msg);
            }
          }}
        />
        <Text style={[type.small, {textAlign: 'center'}]}>
          Opens your organisation's sign-in page. First sign-in needs a connection; after that, downloaded
          camp data works offline.
        </Text>
        <Text style={[type.small, {textAlign: 'center', marginTop: 'auto'}]}>Independent applicant concept · Sample data</Text>
      </View>
    </SafeAreaView>
  );
}

export function LockedScreen() {
  const lastError = useSync(s => s.lastError);
  return (
    <SafeAreaView style={{flex: 1, padding: space.xl, gap: space.l, justifyContent: 'center'}}>
      <LockKeyhole color={colors.text} size={40} />
      <Text style={type.title}>Reconnect to continue</Text>
      <Text style={type.body}>
        This device has been offline longer than the allowed period. Camp data is locked until your access is
        checked again. Work saved on this device is kept and will sync once you reconnect.
      </Text>
      {lastError ? <Banner tone="warning">{lastError}</Banner> : null}
      <Button title="Try again" onPress={startup} />
      <Button title="Sign in again" variant="secondary" onPress={signInAndLoad} />
    </SafeAreaView>
  );
}

export function DbErrorScreen() {
  const error = useSession(s => s.error);
  return (
    <SafeAreaView style={{flex: 1, padding: space.xl, gap: space.l, justifyContent: 'center'}}>
      <Text style={type.title}>Local data could not open</Text>
      <Text style={type.body}>
        Nothing has been deleted. Restart the app; if this keeps happening, contact your supervisor before
        reinstalling, because unsynced work lives in this database.
      </Text>
      <Banner tone="error">{error ?? 'Unknown error'}</Banner>
      <Button title="Retry" onPress={startup} />
    </SafeAreaView>
  );
}

export function CampSelectScreen({onDone}: {onDone?: () => void}) {
  const me = useSession(s => s.me);
  return (
    <SafeAreaView style={{flex: 1, padding: space.l, gap: space.m}}>
      <Text style={type.title}>Choose camp</Text>
      <Text style={type.small}>You only see equipment and rosters for camps you are assigned to.</Text>
      {(me?.camps ?? []).map(c => (
        <Button key={c.id} title={c.name} variant="secondary" onPress={async () => {
          await chooseCamp(c.id);
          onDone?.();
        }} />
      ))}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  hero: {height: 330, justifyContent: 'flex-start'},
  body: {flex: 1, padding: space.xl, gap: space.l},
  headline: {fontFamily: fonts.editorial, fontSize: 40, lineHeight: 44, color: colors.text},
  word: {fontFamily: fonts.body, fontWeight: '900', fontSize: 34, color: colors.text, letterSpacing: -1},
  concept: {fontFamily: fonts.body, fontSize: 11, color: colors.text, marginTop: -4},
});

export const _unused = Image;
