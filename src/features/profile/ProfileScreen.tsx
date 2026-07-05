import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  StatusBar, Switch, Alert, DeviceEventEmitter,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { signOut } from 'firebase/auth';
import {
  computeStreak, getTodayPages, getDailyGoal, setDailyGoal,
  getFollowedIds, setSetting, getDailyLogHistory,
} from '../../data/db';
import { getAllBooks } from '../../data/books';
import { auth } from '../../lib/firebase';
import { type as T, space, radius, shadow } from '../../theme';
import { useColors } from '../../theme/ThemeContext';
import { useTheme } from '../../theme/ThemeContext';
import { RootStackParamList } from '../../navigation';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Tabs'>;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CELL = 12;
const GAP = 2;
const STEP = CELL + GAP;
const WEEKS = 16;

function cellColor(pages: number, isDark: boolean): string {
  if (pages === 0) return isDark ? '#1E293B' : '#E5E7EB';
  const g = '#22c55e';
  if (pages <= 2)  return g + '3D';
  if (pages <= 5)  return g + '66';
  if (pages <= 9)  return g + '99';
  if (pages <= 14) return g + 'CC';
  return g;
}

function ContributionGraph({ history }: { history: { date: string; pages: number }[] }) {
  const colors = useColors();
  const { isDark } = useTheme();
  const cg = useMemo(() => createCgStyles(colors), [colors]);

  const today = new Date();
  const todayDow = today.getDay();
  const startSunday = new Date(today);
  startSunday.setDate(today.getDate() - todayDow - (WEEKS - 1) * 7);
  startSunday.setHours(0, 0, 0, 0);

  const dataMap = new Map(history.map((h) => [h.date, h.pages]));

  const grid: { date: string; pages: number; isFuture: boolean }[][] = [];
  for (let w = 0; w < WEEKS; w++) {
    const week: { date: string; pages: number; isFuture: boolean }[] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(startSunday);
      date.setDate(startSunday.getDate() + w * 7 + d);
      const key = date.toISOString().slice(0, 10);
      week.push({ date: key, pages: dataMap.get(key) ?? 0, isFuture: date > today });
    }
    grid.push(week);
  }

  const monthLabels: (string | null)[] = grid.map((week) => {
    const firstDay = new Date(week[0].date);
    return firstDay.getDate() <= 7 ? MONTHS[firstDay.getMonth()] : null;
  });

  return (
    <View>
      <View style={{ flexDirection: 'row', marginBottom: 3 }}>
        {grid.map((_, w) => (
          <View key={w} style={{ width: STEP }}>
            {monthLabels[w] ? (
              <Text style={cg.monthLabel}>{monthLabels[w]}</Text>
            ) : null}
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: GAP }}>
        {grid.map((week, w) => (
          <View key={w} style={{ gap: GAP }}>
            {week.map((cell, d) => (
              <View
                key={d}
                style={[
                  cg.cell,
                  { backgroundColor: cell.isFuture ? 'transparent' : cellColor(cell.pages, isDark) },
                ]}
              />
            ))}
          </View>
        ))}
      </View>
      <View style={cg.legendRow}>
        <Text style={cg.legendText}>Less</Text>
        {[0, 3, 6, 10, 15].map((n) => (
          <View key={n} style={[cg.cell, { backgroundColor: cellColor(n, isDark) }]} />
        ))}
        <Text style={cg.legendText}>More</Text>
      </View>
    </View>
  );
}

function createCgStyles(colors: ReturnType<typeof useColors>) { return StyleSheet.create({
  cell: { width: CELL, height: CELL, borderRadius: 2 },
  monthLabel: { fontSize: 8, color: colors.textMuted, lineHeight: 10 },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 8, justifyContent: 'flex-end' },
  legendText: { fontSize: 9, color: colors.textMuted },
}); }

export default function ProfileScreen() {
  const colors = useColors();
  const { isDark, toggleTheme } = useTheme();
  const s = useMemo(() => createProfileStyles(colors), [colors]);
  const nav = useNavigation<Nav>();
  const [streak, setStreak] = useState(0);
  const [todayPages, setTodayPages] = useState(0);
  const [goal, setGoal] = useState(5);
  const [followedCount, setFollowedCount] = useState(0);
  const [history, setHistory] = useState<{ date: string; pages: number }[]>([]);
  const [booksFinished, setBooksFinished] = useState(0);
  const [booksReading, setBooksReading] = useState(0);
  const [totalBookPages, setTotalBookPages] = useState(0);

  const userEmail = auth.currentUser?.email ?? null;

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        const [str, p, g, f, hist, bookList] = await Promise.all([
          computeStreak(), getTodayPages(), getDailyGoal(), getFollowedIds(),
          getDailyLogHistory(WEEKS * 7), getAllBooks(),
        ]);
        if (active) {
          setStreak(str); setTodayPages(p); setGoal(g); setFollowedCount(f.length);
          setHistory(hist);
          setBooksFinished(bookList.filter((b) => b.total_pages > 0 && b.current_page >= b.total_pages).length);
          setBooksReading(bookList.filter((b) => b.current_page > 0 && !(b.total_pages > 0 && b.current_page >= b.total_pages)).length);
          setTotalBookPages(bookList.reduce((acc, b) => acc + (b.current_page || 0), 0));
        }
      })();
      return () => { active = false; };
    }, []),
  );

  async function handleSignOut() {
    Alert.alert('Sign out', 'Your reading data stays on this device.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out', style: 'destructive', onPress: async () => {
          await signOut(auth);
          await setSetting('auth_skipped', '0');
        },
      },
    ]);
  }

  async function nudgeGoal(delta: number) {
    const next = Math.max(1, Math.min(50, goal + delta));
    setGoal(next);
    await setDailyGoal(next);
  }

  const progress = Math.min(1, todayPages / goal);
  const progressPct = Math.round(progress * 100);

  function SettingRow({ icon, label, right }: { icon: string; label: string; right: React.ReactNode }) {
    return (
      <View style={s.srRow}>
        <View style={s.srIconWrap}>
          <Ionicons name={icon as any} size={18} color={colors.textSecondary} />
        </View>
        <Text style={s.srLabel}>{label}</Text>
        <View style={s.srRight}>{right}</View>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={colors.bgDeep} />
      <LinearGradient colors={[colors.bgDeep, colors.bg]} style={StyleSheet.absoluteFill} />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={s.scroll}>
        {/* Header */}
        <View style={s.header}>
          <View style={s.avatarRing}>
            <LinearGradient colors={[colors.accent, colors.flame]} style={s.avatar}>
              <Text style={s.avatarGlyph}>{userEmail ? userEmail[0].toUpperCase() : 'Q'}</Text>
            </LinearGradient>
          </View>
          {userEmail ? (
            <>
              <Text style={s.name}>{userEmail}</Text>
              <TouchableOpacity onPress={handleSignOut} style={s.signOutBtn}>
                <Ionicons name="log-out-outline" size={14} color={colors.textMuted} />
                <Text style={s.signOutText}>Sign out</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={s.name}>Reading offline</Text>
              <TouchableOpacity
                onPress={() => DeviceEventEmitter.emit('navigateToAuth')}
                style={s.signInBtn}
              >
                <Ionicons name="log-in-outline" size={14} color={colors.accent} />
                <Text style={s.signInText}>Sign in to sync across devices</Text>
              </TouchableOpacity>
            </>
          )}
          <Text style={s.sub}>Following {followedCount} publication{followedCount !== 1 ? 's' : ''}</Text>
        </View>

        {/* Streak card */}
        <View style={[s.card, s.streakCard]}>
          <LinearGradient
            colors={[colors.flame + '20', colors.accent + '10', 'transparent']}
            style={StyleSheet.absoluteFill}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
          />
          <View style={s.streakRow}>
            <View>
              <Text style={s.streakNum}>{streak}</Text>
              <Text style={s.streakLabel}>Day streak</Text>
            </View>
            <View style={s.flameCircle}>
              <LinearGradient colors={[colors.flame + '40', colors.flame + '10']} style={s.flameCircle}>
                <Text style={s.flameEmoji}>🔥</Text>
              </LinearGradient>
            </View>
          </View>

          <View style={s.progressSection}>
            <View style={s.progressHeader}>
              <Text style={s.progressLabel}>Today</Text>
              <Text style={s.progressFrac}>
                <Text style={{ color: todayPages >= goal ? colors.success : colors.accent }}>{todayPages}</Text>
                <Text style={{ color: colors.textMuted }}>/{goal} pages</Text>
              </Text>
            </View>
            <View style={s.progressTrack}>
              <LinearGradient
                colors={progress >= 1 ? [colors.success, colors.success + 'CC'] : [colors.accentBright, colors.accent]}
                style={[s.progressFill, { width: `${progressPct}%` }]}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
              />
            </View>
            {progress >= 1 ? (
              <View style={s.goalMetRow}>
                <Ionicons name="checkmark-circle" size={16} color={colors.success} />
                <Text style={[s.progressLabel, { color: colors.success }]}>Goal met! Keep it up.</Text>
              </View>
            ) : (
              <Text style={s.progressHint}>
                {goal - todayPages} more {goal - todayPages === 1 ? 'page' : 'pages'} to hit your goal
              </Text>
            )}
          </View>
        </View>

        {/* Contribution graph */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>Reading Activity</Text>
          <View style={s.card}>
            <ContributionGraph history={history} />
          </View>
        </View>

        {/* Daily goal control */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>Daily Reading Goal</Text>
          <View style={s.card}>
            <View style={s.goalRow}>
              <View>
                <Text style={s.goalNum}>{goal}</Text>
                <Text style={s.goalDesc}>pages per day</Text>
              </View>
              <View style={s.goalControls}>
                <TouchableOpacity style={s.goalBtn} onPress={() => nudgeGoal(-1)}>
                  <Ionicons name="remove" size={20} color={colors.text} />
                </TouchableOpacity>
                <TouchableOpacity style={[s.goalBtn, { backgroundColor: colors.accentMuted, borderColor: colors.accentBorder }]} onPress={() => nudgeGoal(1)}>
                  <Ionicons name="add" size={20} color={colors.accent} />
                </TouchableOpacity>
              </View>
            </View>
            <Text style={s.goalHint}>Finishing an article and each page you read in a book both count toward your daily goal.</Text>
          </View>
        </View>

        {/* Stats */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>Reading Stats</Text>

          {/* Articles row */}
          <Text style={s.statsSubLabel}>Articles</Text>
          <View style={[s.statsRow, { marginBottom: 10 }]}>
            <View style={[s.card, s.statCard]}>
              <Ionicons name="flame" size={24} color={colors.flame} />
              <Text style={s.statNum}>{streak}</Text>
              <Text style={s.statLabel}>Day streak</Text>
            </View>
            <View style={[s.card, s.statCard]}>
              <Ionicons name="book-outline" size={24} color={colors.accent} />
              <Text style={s.statNum}>{todayPages}</Text>
              <Text style={s.statLabel}>Pages today</Text>
            </View>
            <View style={[s.card, s.statCard]}>
              <Ionicons name="compass-outline" size={24} color={colors.success} />
              <Text style={s.statNum}>{followedCount}</Text>
              <Text style={s.statLabel}>Sources</Text>
            </View>
          </View>

          {/* Books row */}
          <Text style={s.statsSubLabel}>Books</Text>
          <View style={s.statsRow}>
            <View style={[s.card, s.statCard]}>
              <Ionicons name="checkmark-circle-outline" size={24} color={colors.success} />
              <Text style={s.statNum}>{booksFinished}</Text>
              <Text style={s.statLabel}>Finished</Text>
            </View>
            <View style={[s.card, s.statCard]}>
              <Ionicons name="library-outline" size={24} color={colors.accent} />
              <Text style={s.statNum}>{booksReading}</Text>
              <Text style={s.statLabel}>Reading</Text>
            </View>
            <View style={[s.card, s.statCard]}>
              <Ionicons name="reader-outline" size={24} color={colors.flame} />
              <Text style={s.statNum}>
                {totalBookPages >= 1000
                  ? `${(totalBookPages / 1000).toFixed(1)}k`
                  : totalBookPages}
              </Text>
              <Text style={s.statLabel}>Pages read</Text>
            </View>
          </View>
        </View>

        {/* Settings */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>Settings</Text>
          <View style={s.card}>
            <TouchableOpacity onPress={() => nav.navigate('Highlights')}>
              <SettingRow icon="color-wand-outline" label="My Highlights" right={<Ionicons name="chevron-forward" size={16} color={colors.textMuted} />} />
            </TouchableOpacity>
            <View style={s.divider} />
            <TouchableOpacity onPress={() => nav.navigate('History')}>
              <SettingRow icon="time-outline" label="Reading History" right={<Ionicons name="chevron-forward" size={16} color={colors.textMuted} />} />
            </TouchableOpacity>
            <View style={s.divider} />
            <SettingRow
              icon="moon-outline"
              label="Dark mode"
              right={
                <Switch
                  value={isDark}
                  onValueChange={toggleTheme}
                  thumbColor={colors.accent}
                  trackColor={{ true: colors.accentMuted, false: colors.surfaceHigher }}
                />
              }
            />
            <View style={s.divider} />
            <SettingRow icon="notifications-outline" label="Daily reminder" right={<Text style={s.settingVal}>8:00 AM</Text>} />
            <View style={s.divider} />
            <SettingRow icon="text-outline" label="Font size" right={<Text style={s.settingVal}>Medium</Text>} />
          </View>
        </View>

        {/* About */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>About</Text>
          <View style={s.card}>
            <SettingRow icon="information-circle-outline" label="Version" right={<Text style={s.settingVal}>1.0.0</Text>} />
            <View style={s.divider} />
            <SettingRow icon="heart-outline" label="Made with love" right={<Text style={s.settingVal}>✦ Quill</Text>} />
          </View>
        </View>

        <View style={{ height: 100 }} />
      </ScrollView>
    </View>
  );
}

function createProfileStyles(colors: ReturnType<typeof useColors>) { return StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgDeep },
  scroll: { paddingTop: 60 },
  header: { alignItems: 'center', paddingBottom: space.xl, paddingHorizontal: space.lg },
  avatarRing: {
    width: 88, height: 88, borderRadius: 44, padding: 3,
    borderWidth: 2, borderColor: colors.accentBorder, marginBottom: space.md,
  },
  avatar: { flex: 1, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  avatarGlyph: { fontSize: 36, fontWeight: '800', color: colors.bgDeep },
  name: { ...T.h3, color: colors.text, marginBottom: 4 },
  sub: { ...T.caption, color: colors.textMuted, marginBottom: 2 },
  signOutBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: 4, paddingHorizontal: 10,
    borderRadius: radius.full, borderWidth: 1, borderColor: colors.border,
    marginBottom: 6,
  },
  signOutText: { ...T.caption, color: colors.textMuted },
  signInBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: 6, paddingHorizontal: 14,
    borderRadius: radius.full, borderWidth: 1, borderColor: colors.accentBorder,
    backgroundColor: colors.accentMuted, marginBottom: 6,
  },
  signInText: { ...T.caption, color: colors.accent, fontWeight: '600' },
  card: {
    backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: space.md,
    overflow: 'hidden', ...shadow.card,
  },
  streakCard: { marginHorizontal: space.md, marginBottom: space.md },
  streakRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.md },
  streakNum: { fontSize: 56, fontWeight: '800', color: colors.flame, lineHeight: 60 },
  streakLabel: { ...T.label, color: colors.textSecondary },
  flameCircle: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  flameEmoji: { fontSize: 32 },
  progressSection: {},
  progressHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  progressLabel: { ...T.label, color: colors.textSecondary },
  progressFrac: { ...T.label },
  progressTrack: {
    height: 6, backgroundColor: colors.surfaceHigher, borderRadius: 3, overflow: 'hidden', marginBottom: 8,
  },
  progressFill: { height: '100%', borderRadius: 3 },
  goalMetRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  progressHint: { ...T.caption, color: colors.textMuted },
  section: { paddingHorizontal: space.md, marginBottom: space.md },
  sectionTitle: { ...T.label, color: colors.textMuted, marginBottom: space.sm },
  goalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  goalNum: { fontSize: 40, fontWeight: '800', color: colors.text, lineHeight: 44 },
  goalDesc: { ...T.caption, color: colors.textMuted },
  goalControls: { flexDirection: 'row', gap: 10 },
  goalBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: colors.surfaceHigher, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  goalHint: { ...T.caption, color: colors.textMuted, lineHeight: 18 },
  statsRow: { flexDirection: 'row', gap: 10 },
  statsSubLabel: { ...T.caption, color: colors.textMuted, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 6, marginTop: 4 },
  statCard: { flex: 1, alignItems: 'center', paddingVertical: space.md },
  statNum: { fontSize: 28, fontWeight: '800', color: colors.text, marginTop: 6, marginBottom: 2 },
  statLabel: { ...T.caption, color: colors.textMuted },
  divider: { height: 1, backgroundColor: colors.border },
  settingVal: { ...T.caption, color: colors.textMuted },
  srRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  srIconWrap: { width: 32 },
  srLabel: { ...T.body, color: colors.text, flex: 1 },
  srRight: { alignItems: 'flex-end' },
}); }
