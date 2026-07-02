import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  StatusBar, Switch, Alert, DeviceEventEmitter,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import {
  computeStreak, getTodayReads, getDailyGoal, setDailyGoal, getFollowedIds, setSetting,
} from '../../data/db';
import { supabase } from '../../lib/supabase';
import { colors, type as T, space, radius, shadow } from '../../theme';
import { RootStackParamList } from '../../navigation';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Tabs'>;

export default function ProfileScreen() {
  const nav = useNavigation<Nav>();
  const [streak, setStreak] = useState(0);
  const [todayReads, setTodayReads] = useState(0);
  const [goal, setGoal] = useState(3);
  const [followedCount, setFollowedCount] = useState(0);
  const [darkMode] = useState(true);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        const [s, t, g, f] = await Promise.all([
          computeStreak(), getTodayReads(), getDailyGoal(), getFollowedIds(),
        ]);
        const { data: { session } } = await supabase.auth.getSession();
        if (active) {
          setStreak(s); setTodayReads(t); setGoal(g); setFollowedCount(f.length);
          setUserEmail(session?.user?.email ?? null);
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
          await supabase.auth.signOut();
          await setSetting('auth_skipped', '0');
        },
      },
    ]);
  }

  async function nudgeGoal(delta: number) {
    const next = Math.max(1, Math.min(20, goal + delta));
    setGoal(next);
    await setDailyGoal(next);
  }

  const progress = Math.min(1, todayReads / goal);
  const progressPct = Math.round(progress * 100);

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bgDeep} />
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

          {/* Today's progress */}
          <View style={s.progressSection}>
            <View style={s.progressHeader}>
              <Text style={s.progressLabel}>Today</Text>
              <Text style={s.progressFrac}>
                <Text style={{ color: todayReads >= goal ? colors.success : colors.accent }}>{todayReads}</Text>
                <Text style={{ color: colors.textMuted }}>/{goal} reads</Text>
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
                {goal - todayReads} more {goal - todayReads === 1 ? 'read' : 'reads'} to hit your goal
              </Text>
            )}
          </View>
        </View>

        {/* Daily goal control */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>Daily Reading Goal</Text>
          <View style={s.card}>
            <View style={s.goalRow}>
              <View>
                <Text style={s.goalNum}>{goal}</Text>
                <Text style={s.goalDesc}>articles per day</Text>
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
            <Text style={s.goalHint}>
              A qualifying read is 90 seconds of reading or reaching 60% of an article.
            </Text>
          </View>
        </View>

        {/* Stats row */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>Reading Stats</Text>
          <View style={s.statsRow}>
            <View style={[s.card, s.statCard]}>
              <Ionicons name="flame" size={24} color={colors.flame} />
              <Text style={s.statNum}>{streak}</Text>
              <Text style={s.statLabel}>Streak</Text>
            </View>
            <View style={[s.card, s.statCard]}>
              <Ionicons name="book-outline" size={24} color={colors.accent} />
              <Text style={s.statNum}>{todayReads}</Text>
              <Text style={s.statLabel}>Today</Text>
            </View>
            <View style={[s.card, s.statCard]}>
              <Ionicons name="library-outline" size={24} color={colors.success} />
              <Text style={s.statNum}>{followedCount}</Text>
              <Text style={s.statLabel}>Sources</Text>
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
            <SettingRow icon="moon-outline" label="Dark mode" right={<Switch value={darkMode} onValueChange={() => {}} thumbColor={colors.accent} trackColor={{ true: colors.accentMuted, false: colors.surfaceHigher }} />} />
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

function SettingRow({ icon, label, right }: { icon: string; label: string; right: React.ReactNode }) {
  return (
    <View style={sr.row}>
      <View style={sr.iconWrap}>
        <Ionicons name={icon as any} size={18} color={colors.textSecondary} />
      </View>
      <Text style={sr.label}>{label}</Text>
      <View style={sr.right}>{right}</View>
    </View>
  );
}

const sr = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  iconWrap: { width: 32 },
  label: { ...T.body, color: colors.text, flex: 1 },
  right: { alignItems: 'flex-end' },
});

const s = StyleSheet.create({
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
  statCard: { flex: 1, alignItems: 'center', paddingVertical: space.md },
  statNum: { fontSize: 28, fontWeight: '800', color: colors.text, marginTop: 6, marginBottom: 2 },
  statLabel: { ...T.caption, color: colors.textMuted },
  divider: { height: 1, backgroundColor: colors.border },
  settingVal: { ...T.caption, color: colors.textMuted },
});
