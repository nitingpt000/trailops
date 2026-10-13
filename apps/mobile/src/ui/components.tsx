/** Shared UI primitives (spec §9): buttons, rows, status labels, offline strip, receipts, dialogs. */
import React, {useRef, useState} from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
  ViewStyle,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {ArrowLeft, ChevronRight, CircleAlert, CloudOff, Info} from 'lucide-react-native';
import {STATUS_LABEL, type EquipmentStatus, type Tone} from '@trailops/contracts';
import {categoryImages, colors, fonts, radius, space, toneColors, touchTargetMin, type} from './tokens';

/**
 * Primary/secondary action. Guards against double taps: `onPress` may be async and the button stays
 * disabled until it settles (spec §9 "prevents double taps").
 */
export function Button({
  title, onPress, variant = 'primary', disabled, icon, testID, style,
}: {
  title: string;
  onPress: () => unknown | Promise<unknown>;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  icon?: React.ReactNode;
  testID?: string;
  style?: ViewStyle;
}) {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const isDisabled = disabled || busy;
  const handle = async () => {
    if (inFlight.current || isDisabled) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await onPress();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const bg = {
    primary: colors.primary, secondary: colors.surface, danger: colors.surface, ghost: 'transparent',
  }[variant];
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{disabled: isDisabled, busy}}
      onPress={handle}
      style={({pressed}) => [
        styles.button,
        {backgroundColor: pressed && variant === 'primary' ? colors.primaryPressed : bg},
        variant !== 'primary' && variant !== 'ghost' && styles.buttonOutline,
        variant === 'danger' && {borderColor: colors.error},
        isDisabled && styles.buttonDisabled,
        style,
      ]}>
      {busy ? <ActivityIndicator color={colors.text} /> : icon}
      <Text style={[type.button, variant === 'danger' && {color: colors.error}, variant !== 'primary' && styles.secondaryText]}>
        {title}
      </Text>
    </Pressable>
  );
}

export function Screen({
  title, subtitle, onBack, children, footer, scroll = true, right,
}: {
  title?: string;
  subtitle?: string;
  onBack?: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  scroll?: boolean;
  right?: React.ReactNode;
}) {
  const body = (
    <>
      {title ? (
        <View style={styles.screenHeader}>
          <Text style={styles.screenTitle} accessibilityRole="header">{title}</Text>
          {subtitle ? <Text style={[type.small, {fontSize: 15}]}>{subtitle}</Text> : null}
        </View>
      ) : null}
      {children}
    </>
  );
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']}>
      {onBack || right ? (
        <View style={styles.backBar}>
          {onBack ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} style={styles.iconButton}>
              <ArrowLeft color={colors.text} size={24} />
            </Pressable>
          ) : <View />}
          {right}
        </View>
      ) : null}
      {scroll ? (
        <ScrollView contentContainerStyle={styles.scrollBody} keyboardShouldPersistTaps="handled">{body}</ScrollView>
      ) : (
        <View style={[styles.scrollBody, {flex: 1}]}>{body}</View>
      )}
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </SafeAreaView>
  );
}

export function Card({children, style}: {children: React.ReactNode; style?: ViewStyle}) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Row({
  title, subtitle, meta, left, onPress, right, testID, accessibilityLabel,
}: {
  title: string;
  subtitle?: string | null;
  meta?: string | null;
  left?: React.ReactNode;
  onPress?: () => void;
  right?: React.ReactNode;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const content = (
    <View style={styles.row}>
      {left}
      <View style={{flex: 1, gap: 2}}>
        <Text style={[type.body, {fontWeight: '700', fontSize: 16}]}>{title}</Text>
        {subtitle ? <Text style={type.small}>{subtitle}</Text> : null}
        {meta ? <Text style={[type.small, {color: colors.text}]}>{meta}</Text> : null}
      </View>
      {right}
      {onPress ? <ChevronRight color={colors.text} size={20} /> : null}
    </View>
  );
  if (!onPress) return content;
  return (
    <Pressable testID={testID} onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title}
      style={({pressed}) => pressed && {backgroundColor: colors.neutralBg}}>
      {content}
    </Pressable>
  );
}

export function Pill({label, tone = 'neutral'}: {label: string; tone?: Tone}) {
  const c = toneColors[tone];
  return (
    <View style={[styles.pill, {backgroundColor: c.bg}]}>
      <Text style={{color: c.fg, fontFamily: fonts.body, fontSize: 13, fontWeight: '600'}}>{label}</Text>
    </View>
  );
}

export function StatusPill({status}: {status: EquipmentStatus}) {
  const s = STATUS_LABEL[status];
  return <Pill label={s.label} tone={s.tone} />;
}

export function Banner({tone = 'warning', title, children, icon}: {
  tone?: Tone; title?: string; children?: React.ReactNode; icon?: React.ReactNode;
}) {
  const c = toneColors[tone];
  return (
    <View style={[styles.banner, {backgroundColor: c.bg}]} accessibilityRole="alert">
      {icon ?? (tone === 'error' ? <CircleAlert color={c.fg} size={20} /> : <Info color={c.fg} size={20} />)}
      <View style={{flex: 1, gap: 2}}>
        {title ? <Text style={{color: c.fg, fontFamily: fonts.body, fontWeight: '700', fontSize: 15}}>{title}</Text> : null}
        {typeof children === 'string' ? <Text style={[type.small, {color: colors.text}]}>{children}</Text> : children}
      </View>
    </View>
  );
}

export function OfflineStrip({online, pending, onPress}: {online: boolean; pending: number; onPress?: () => void}) {
  if (online && pending === 0) return null;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={styles.offline} testID="offline-strip">
      <CloudOff color={online ? colors.warning : colors.error} size={18} />
      <Text style={[type.small, {color: colors.text, flex: 1}]}>
        <Text style={{fontWeight: '700'}}>{online ? 'Online' : 'Offline'}</Text>
        {pending > 0 ? ` · ${pending} change${pending === 1 ? '' : 's'} saved on this device` : ' · Changes saved on this device'}
      </Text>
      <ChevronRight color={colors.text} size={16} />
    </Pressable>
  );
}

export function Field({label, children, hint, error}: {label: string; children: React.ReactNode; hint?: string; error?: string}) {
  return (
    <View style={{gap: 6}}>
      <Text style={type.label}>{label}</Text>
      {children}
      {error ? <Text style={[type.small, {color: colors.error}]}>{error}</Text> : hint ? <Text style={type.small}>{hint}</Text> : null}
    </View>
  );
}

export function Input(props: TextInputProps) {
  return <TextInput placeholderTextColor={colors.muted} {...props} style={[styles.input, props.multiline && {minHeight: 96, textAlignVertical: 'top'}, props.style]} />;
}

export function Choice({options, value, onChange, testIDPrefix}: {
  options: {value: string; label: string}[];
  value: string | null | undefined;
  onChange: (v: string) => void;
  testIDPrefix?: string;
}) {
  return (
    <View style={{gap: 8}} accessibilityRole="radiogroup">
      {options.map(o => {
        const selected = o.value === value;
        return (
          <Pressable key={o.value} testID={testIDPrefix ? `${testIDPrefix}-${o.value}` : undefined}
            accessibilityRole="radio" accessibilityState={{checked: selected}}
            onPress={() => onChange(o.value)}
            style={[styles.choice, selected && {backgroundColor: '#FFF3C4', borderColor: colors.primary}]}>
            <View style={[styles.radio, selected && {borderColor: colors.text}]}>
              {selected ? <View style={styles.radioDot} /> : null}
            </View>
            <Text style={type.body}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function ItemThumb({imageKey, size = 64}: {imageKey?: string | null; size?: number}) {
  const src = imageKey ? categoryImages[imageKey] : undefined;
  return (
    <View style={[styles.thumb, {width: size, height: size}]}>
      {src ? <Image source={src} style={{width: size, height: size}} resizeMode="cover" accessibilityIgnoresInvertColors /> : null}
    </View>
  );
}

export function Empty({title, body}: {title: string; body?: string}) {
  return (
    <View style={{padding: space.xl, alignItems: 'center', gap: 6}}>
      <Text style={type.heading}>{title}</Text>
      {body ? <Text style={[type.small, {textAlign: 'center'}]}>{body}</Text> : null}
    </View>
  );
}

export function Divider() {
  return <View style={{height: 1, backgroundColor: colors.divider}} />;
}

export function Sheet({visible, onClose, title, children}: {visible: boolean; onClose: () => void; title: string; children: React.ReactNode}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View style={styles.sheet} accessibilityViewIsModal>
        <Text style={[type.heading, {marginBottom: space.m}]}>{title}</Text>
        <ScrollView style={{maxHeight: 460}} keyboardShouldPersistTaps="handled">{children}</ScrollView>
      </View>
    </Modal>
  );
}

export function KeyValue({k, v, icon}: {k: string; v: React.ReactNode; icon?: React.ReactNode}) {
  return (
    <View style={styles.kv}>
      {icon}
      <Text style={[type.small, {width: 120}]}>{k}</Text>
      {typeof v === 'string' ? <Text style={[type.body, {flex: 1, fontWeight: '600'}]}>{v}</Text> : <View style={{flex: 1}}>{v}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: touchTargetMin + 4, borderRadius: radius.button, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 10, paddingHorizontal: space.l,
  },
  buttonOutline: {borderWidth: 1.5, borderColor: colors.text},
  buttonDisabled: {opacity: 0.45},
  secondaryText: {fontFamily: fonts.body, fontSize: 16, fontWeight: '600'},
  screen: {flex: 1, backgroundColor: colors.surface},
  screenHeader: {gap: 4, marginBottom: space.l},
  screenTitle: {...type.title},
  backBar: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.s, paddingTop: space.s},
  iconButton: {width: touchTargetMin, height: touchTargetMin, alignItems: 'center', justifyContent: 'center'},
  scrollBody: {padding: space.l, gap: space.l, paddingBottom: space.xxl},
  footer: {padding: space.l, gap: space.s, borderTopWidth: 1, borderTopColor: colors.divider, backgroundColor: colors.surface},
  card: {backgroundColor: colors.surface, borderRadius: radius.panel, borderWidth: 1, borderColor: colors.divider, padding: space.m, gap: space.s},
  row: {flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: space.m, minHeight: touchTargetMin + 8},
  pill: {alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4},
  banner: {flexDirection: 'row', gap: space.s, padding: space.m, borderRadius: radius.panel, alignItems: 'flex-start'},
  offline: {
    flexDirection: 'row', alignItems: 'center', gap: space.s, backgroundColor: '#FFF6E5', borderRadius: radius.panel,
    paddingHorizontal: space.m, minHeight: 44,
  },
  input: {
    borderWidth: 1, borderColor: '#D0D5DD', borderRadius: radius.input, paddingHorizontal: space.m, minHeight: touchTargetMin,
    fontFamily: fonts.body, fontSize: 15, color: colors.text, backgroundColor: colors.surface,
  },
  choice: {
    flexDirection: 'row', alignItems: 'center', gap: space.m, borderWidth: 1, borderColor: colors.divider, borderRadius: radius.input,
    paddingHorizontal: space.m, minHeight: touchTargetMin,
  },
  radio: {width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.muted, alignItems: 'center', justifyContent: 'center'},
  radioDot: {width: 12, height: 12, borderRadius: 6, backgroundColor: colors.text},
  thumb: {borderRadius: 10, overflow: 'hidden', backgroundColor: colors.neutralBg},
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.35)'},
  sheet: {backgroundColor: colors.surface, padding: space.l, borderTopLeftRadius: 16, borderTopRightRadius: 16, gap: space.s},
  kv: {flexDirection: 'row', alignItems: 'flex-start', gap: space.s, paddingVertical: 10},
});
