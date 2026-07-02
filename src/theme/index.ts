export const colors = {
  // Core backgrounds
  bg: '#090C15',
  bgDeep: '#060810',
  surface: '#0E1525',
  surfaceHigh: '#131C2E',
  surfaceHigher: '#1A2540',

  // Glass / borders
  border: 'rgba(255,255,255,0.07)',
  borderStrong: 'rgba(255,255,255,0.13)',

  // Brand accent – warm gold (quill/ink)
  accent: '#C8AA6E',
  accentBright: '#E2C47A',
  accentMuted: 'rgba(200,170,110,0.12)',
  accentBorder: 'rgba(200,170,110,0.3)',

  // Text
  text: '#EDE8E0',
  textSecondary: '#8E96A9',
  textMuted: '#505869',

  // Streak
  flame: '#F97316',
  flameMuted: 'rgba(249,115,22,0.15)',

  // Status
  success: '#34D399',
  white: '#FFFFFF',

  // Per-publication accent palette
  pub: {
    'paul-graham':  '#E8834A',
    'yc-blog':      '#EF4444',
    'naval':        '#60A5FA',
    'wait-but-why': '#34D399',
    'sam-altman':   '#A78BFA',
    'vox':          '#FBBF24',
  } as Record<string, string>,
};

export const type = {
  // Display
  d1: { fontSize: 32, fontWeight: '800' as const, letterSpacing: -0.5 },
  d2: { fontSize: 26, fontWeight: '800' as const, letterSpacing: -0.3 },
  // Heading
  h1: { fontSize: 22, fontWeight: '700' as const, letterSpacing: -0.2 },
  h2: { fontSize: 18, fontWeight: '700' as const, letterSpacing: -0.1 },
  h3: { fontSize: 16, fontWeight: '600' as const },
  // Body
  body: { fontSize: 17, fontWeight: '400' as const, lineHeight: 28 },
  bodyLg: { fontSize: 19, fontWeight: '400' as const, lineHeight: 31 },
  // UI
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
