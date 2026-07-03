export const darkColors = {
  bg: '#090C15',
  bgDeep: '#060810',
  surface: '#0E1525',
  surfaceHigh: '#131C2E',
  surfaceHigher: '#1A2540',
  border: 'rgba(255,255,255,0.07)',
  borderStrong: 'rgba(255,255,255,0.13)',
  accent: '#C8AA6E',
  accentBright: '#E2C47A',
  accentMuted: 'rgba(200,170,110,0.12)',
  accentBorder: 'rgba(200,170,110,0.3)',
  text: '#EDE8E0',
  textSecondary: '#8E96A9',
  textMuted: '#505869',
  flame: '#F97316',
  flameMuted: 'rgba(249,115,22,0.15)',
  success: '#34D399',
  white: '#FFFFFF',
  pub: {
    'paul-graham':  '#E8834A',
    'yc-blog':      '#EF4444',
    'naval':        '#60A5FA',
    'wait-but-why': '#34D399',
    'sam-altman':   '#A78BFA',
    'vox':          '#FBBF24',
  } as Record<string, string>,
};

export const lightColors = {
  bg: '#F5F4F0',
  bgDeep: '#EDECEA',
  surface: '#FFFFFF',
  surfaceHigh: '#F8F7F4',
  surfaceHigher: '#EEECe7',
  border: 'rgba(0,0,0,0.09)',
  borderStrong: 'rgba(0,0,0,0.16)',
  accent: '#A67C3D',
  accentBright: '#C8A050',
  accentMuted: 'rgba(166,124,61,0.10)',
  accentBorder: 'rgba(166,124,61,0.28)',
  text: '#1C1A17',
  textSecondary: '#5C5750',
  textMuted: '#9A9590',
  flame: '#D95E10',
  flameMuted: 'rgba(217,94,16,0.12)',
  success: '#16A34A',
  white: '#FFFFFF',
  pub: {
    'paul-graham':  '#C06020',
    'yc-blog':      '#DC2626',
    'naval':        '#2563EB',
    'wait-but-why': '#16A34A',
    'sam-altman':   '#7C3AED',
    'vox':          '#D97706',
  } as Record<string, string>,
};

// Default export keeps backward compatibility for any static references
export const colors = darkColors;

export type Colors = typeof darkColors;

export const type = {
  d1: { fontSize: 32, fontWeight: '800' as const, letterSpacing: -0.5 },
  d2: { fontSize: 26, fontWeight: '800' as const, letterSpacing: -0.3 },
  h1: { fontSize: 22, fontWeight: '700' as const, letterSpacing: -0.2 },
  h2: { fontSize: 18, fontWeight: '700' as const, letterSpacing: -0.1 },
  h3: { fontSize: 16, fontWeight: '600' as const },
  body: { fontSize: 17, fontWeight: '400' as const, lineHeight: 28 },
  bodyLg: { fontSize: 19, fontWeight: '400' as const, lineHeight: 31 },
  label: { fontSize: 12, fontWeight: '600' as const, letterSpacing: 0.8, textTransform: 'uppercase' as const },
  caption: { fontSize: 12, fontWeight: '400' as const },
  badge: { fontSize: 11, fontWeight: '700' as const, letterSpacing: 0.5 },
};

export const space = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  full: 999,
};

export const shadow = {
  card: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
  },
};
