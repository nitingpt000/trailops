/**
 * Design tokens from trailops-assets/design-system/tokens.ts (proposed values inferred from the
 * generated concepts, not official brand tokens).
 */
export const colors = {
  primary: '#FFCC00',
  primaryPressed: '#E6B800',
  text: '#151515',
  surface: '#FFFFFF',
  canvas: '#F6F5EF',
  muted: '#667085',
  divider: '#E5E7EB',
  success: '#16803C',
  successBg: '#E8F5EC',
  warning: '#B45309',
  warningBg: '#FFF4DB',
  error: '#DC2626',
  errorBg: '#FDECEC',
  info: '#2563EB',
  infoBg: '#E8EFFD',
  neutralBg: '#F1F2F4',
  black: '#111111',
};

export const fonts = {
  body: 'Inter',
  condensed: 'Oswald',
  editorial: 'DMSerifDisplay',
};

export const space = {xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32, xxxl: 48};
export const radius = {input: 8, button: 8, panel: 12};
export const touchTargetMin = 48;

export const type = {
  title: {fontFamily: fonts.editorial, fontSize: 30, color: colors.text},
  heading: {fontFamily: fonts.body, fontSize: 18, fontWeight: '700' as const, color: colors.text},
  body: {fontFamily: fonts.body, fontSize: 15, color: colors.text},
  small: {fontFamily: fonts.body, fontSize: 13, color: colors.muted},
  label: {fontFamily: fonts.body, fontSize: 14, fontWeight: '600' as const, color: colors.text},
  button: {fontFamily: fonts.condensed, fontSize: 18, fontWeight: '600' as const, color: colors.text},
};

export const toneColors = {
  success: {fg: colors.success, bg: colors.successBg},
  info: {fg: colors.info, bg: colors.infoBg},
  warning: {fg: colors.warning, bg: colors.warningBg},
  error: {fg: colors.error, bg: colors.errorBg},
  neutral: {fg: colors.muted, bg: colors.neutralBg},
} as const;

export const categoryImages: Record<string, number> = {
  'padded-jacket': require('../../assets/images/padded-jacket.png'),
  'trekking-poles': require('../../assets/images/trekking-poles.png'),
  'trekking-shoes': require('../../assets/images/trekking-shoes.png'),
  backpack: require('../../assets/images/backpack.png'),
  'sleeping-bag': require('../../assets/images/sleeping-bag.png'),
};
