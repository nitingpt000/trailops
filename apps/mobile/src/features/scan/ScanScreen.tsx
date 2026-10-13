/**
 * QR identification (spec §12). Camera permission is requested only when scanning starts; denial
 * falls back to manual tag entry. Scanning pauses when the screen loses focus or the app backgrounds,
 * and repeated detections of the same frame open one detail view.
 */
import React, {useCallback, useRef, useState} from 'react';
import {AppState, Pressable, StyleSheet, Text, View} from 'react-native';
import {useIsFocused} from '@react-navigation/native';
import {Q} from '@nozbe/watermelondb';
import {Camera, useCameraDevice, useCameraPermission, useCodeScanner} from 'react-native-vision-camera';
import {Flashlight, Keyboard, X} from 'lucide-react-native';
import {parseEquipmentLabel} from '@trailops/contracts';
import type {ScreenProps} from '../../app/navigation';
import {useDb} from '../../app/session';
import type {ProjectionRecord} from '../../database/models';
import {Banner, Button, Input, Sheet} from '../../ui/components';
import {colors, space, type} from '../../ui/tokens';

export function ScanScreen({navigation}: ScreenProps<'Scan'>) {
  const db = useDb();
  const focused = useIsFocused();
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', s => setAppActive(s === 'active'));
    return () => sub.remove();
  }, []);
  const {hasPermission, requestPermission} = useCameraPermission();
  const [asked, setAsked] = useState(false);
  const device = useCameraDevice('back');
  const [torch, setTorch] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [tag, setTag] = useState('');
  const handled = useRef<{value: string; at: number} | null>(null);

  React.useEffect(() => {
    if (!hasPermission && !asked) {
      setAsked(true);
      requestPermission();
    }
  }, [hasPermission, asked, requestPermission]);

  const openById = useCallback(async (id: string) => {
    const rows = await db.get<ProjectionRecord>('equipment').query(Q.where('server_id', id)).fetch();
    if (!rows.length) {
      // Never creates an item from a label (spec §12).
      setMessage('Not downloaded for this camp.');
      return;
    }
    navigation.replace('EquipmentDetail', {itemId: id});
  }, [db, navigation]);

  const openByTag = useCallback(async (raw: string) => {
    const t = raw.trim().toUpperCase();
    const rows = await db.get<ProjectionRecord>('equipment').query(Q.where('tag', t)).fetch();
    if (!rows.length) {
      setMessage(`${t || 'That tag'} is not downloaded for this camp.`);
      return;
    }
    setManual(false);
    navigation.replace('EquipmentDetail', {itemId: rows[0].serverId});
  }, [db, navigation]);

  const scanner = useCodeScanner({
    codeTypes: ['qr'],
    onCodeScanned: codes => {
      const value = codes[0]?.value;
      if (!value) return;
      const now = Date.now();
      if (handled.current && handled.current.value === value && now - handled.current.at < 2500) return; // debounce
      handled.current = {value, at: now};
      const parsed = parseEquipmentLabel(value);
      if (!parsed.ok) {
        setMessage(parsed.reason === 'BAD_CHECKSUM' ? 'Label checksum does not match. Enter the tag manually.' : 'Not a TrailOps equipment label.');
        return;
      }
      void openById(parsed.id);
    },
  });

  const active = focused && appActive && hasPermission && !manual && !!device;
  return (
    <View style={{flex: 1, backgroundColor: '#000'}}>
      {device && hasPermission ? (
        <Camera style={StyleSheet.absoluteFill} device={device} isActive={active} codeScanner={scanner} torch={torch ? 'on' : 'off'} />
      ) : null}
      <View style={styles.overlay}>
        <View style={{flexDirection: 'row', justifyContent: 'flex-end'}}>
          <Pressable accessibilityRole="button" accessibilityLabel="Close scanner" onPress={navigation.goBack} style={styles.round}>
            <X color="#fff" size={26} />
          </Pressable>
        </View>
        <Text style={styles.title}>Scan equipment</Text>
        <Text style={styles.sub}>Align the equipment tag within the frame</Text>
        <View style={styles.frame} accessibilityElementsHidden />
        {!hasPermission && asked ? (
          <Banner tone="warning" title="Camera not available">Camera permission was denied. Enter the tag code instead; everything else still works.</Banner>
        ) : null}
        {message ? <Banner tone="warning">{message}</Banner> : null}
        <View style={{alignItems: 'center', gap: 6}}>
          <Pressable accessibilityRole="button" accessibilityLabel={torch ? 'Torch off' : 'Torch on'} disabled={!device?.hasTorch}
            onPress={() => setTorch(t => !t)} style={[styles.round, {width: 64, height: 64, borderWidth: 2, borderColor: '#fff'}]}>
            <Flashlight color="#fff" size={26} />
          </Pressable>
          <Text style={{color: '#fff'}}>Torch</Text>
        </View>
        <Button testID="enter-tag" title="Enter tag code manually" variant="secondary" icon={<Keyboard color={colors.text} size={22} />}
          onPress={() => { setMessage(null); setManual(true); }} />
      </View>
      <Sheet visible={manual} onClose={() => setManual(false)} title="Enter tag code">
        <View style={{gap: space.m}}>
          <Input testID="manual-tag" value={tag} onChangeText={setTag} placeholder="e.g. JKT-014" autoCapitalize="characters"
            autoFocus accessibilityLabel="Tag code" maxLength={12} onSubmitEditing={() => openByTag(tag)} />
          {message ? <Text style={[type.small, {color: colors.error}]}>{message}</Text> : null}
          <Button testID="open-tag" title="Open" onPress={() => openByTag(tag)} disabled={!tag.trim()} />
        </View>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {flex: 1, padding: space.l, gap: space.l, justifyContent: 'space-between', paddingTop: space.xxl},
  title: {color: '#fff', fontSize: 28, fontWeight: '800', textAlign: 'center', fontFamily: 'Oswald'},
  sub: {color: '#fff', fontSize: 16, textAlign: 'center'},
  frame: {alignSelf: 'center', width: 240, height: 240, borderWidth: 4, borderColor: colors.primary, borderRadius: 16},
  round: {width: 48, height: 48, borderRadius: 32, alignItems: 'center', justifyContent: 'center'},
});
