import React, { useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, StatusBar, Dimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { TOPICS, PUBLICATIONS } from '../../data/publications';
import { followPublication, setSetting } from '../../data/db';
import { type as T, space, radius } from '../../theme';
import { useColors } from '../../theme/ThemeContext';

const { width } = Dimensions.get('window');

interface Props { onDone: () => void }

export default function OnboardingScreen({ onDone }: Props) {
  const [step, setStep] = useState<'topics' | 'pubs'>('topics');
  const [selectedTopics, setSelectedTopics] = useState<Set<string>>(new Set());
  const [selectedPubs, setSelectedPubs] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const colors = useColors();
  const s = useMemo(() => createOnboardingStyles(colors), [colors]);

  const suggestedPubs = PUBLICATIONS.filter((p) =>
    p.topics.some((t) => selectedTopics.has(t)),
  );
  const displayPubs = suggestedPubs.length > 0 ? suggestedPubs : PUBLICATIONS;

  function toggleTopic(id: string) {
    setSelectedTopics((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function togglePub(id: string) {
    setSelectedPubs((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function finish(followAll = false) {
    setLoading(true);
    try {
      const toFollow = followAll ? displayPubs.map((p) => p.id) : [...selectedPubs];
      for (const id of toFollow) await followPublication(id);
      await setSetting('onboarding_done', '1');
      onDone();
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bgDeep} />
      <LinearGradient colors={[colors.bgDeep, colors.bg]} style={StyleSheet.absoluteFill} />

      {/* Header */}
      <View style={s.header}>
        <LinearGradient
          colors={[colors.accent + '22', 'transparent']}
          style={s.logoRing}
        >
          <Text style={s.logoGlyph}>✦</Text>
        </LinearGradient>
        <Text style={s.wordmark}>Quill</Text>
        <Text style={s.tagline}>Read what matters. Every day.</Text>
      </View>

      {/* Step indicator */}
      <View style={s.steps}>
        <View style={[s.dot, step === 'topics' && s.dotActive]} />
        <View style={[s.dot, step === 'pubs' && s.dotActive]} />
      </View>

      {step === 'topics' ? (
        <>
          <Text style={s.sectionTitle}>What do you care about?</Text>
          <Text style={s.sectionSub}>Pick your interests to personalize your feed</Text>
          <ScrollView contentContainerStyle={s.grid} showsVerticalScrollIndicator={false}>
            {TOPICS.map((topic) => {
              const sel = selectedTopics.has(topic.id);
              return (
                <TouchableOpacity
                  key={topic.id}
                  style={[s.topicChip, sel && { borderColor: topic.color, backgroundColor: topic.color + '18' }]}
                  onPress={() => toggleTopic(topic.id)}
                  activeOpacity={0.7}
                >
                  <Text style={s.topicEmoji}>{topic.emoji}</Text>
                  <Text style={[s.topicLabel, sel && { color: topic.color }]}>{topic.label}</Text>
                  {sel && <Ionicons name="checkmark-circle" size={16} color={topic.color} style={{ marginLeft: 4 }} />}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
          <View style={s.footer}>
            <TouchableOpacity
              style={s.primaryBtn}
              onPress={() => setStep('pubs')}
              activeOpacity={0.85}
            >
              <LinearGradient colors={[colors.accentBright, colors.accent]} style={s.btnGrad}>
                <Text style={s.btnText}>Continue</Text>
                <Ionicons name="arrow-forward" size={18} color={colors.bgDeep} style={{ marginLeft: 6 }} />
              </LinearGradient>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setStep('pubs')} style={s.skipBtn}>
              <Text style={s.skipText}>Skip</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : (
        <>
          <Text style={s.sectionTitle}>Follow publications</Text>
          <Text style={s.sectionSub}>Select the writers you want to read</Text>
          <ScrollView contentContainerStyle={s.pubList} showsVerticalScrollIndicator={false}>
            {displayPubs.map((pub) => {
              const sel = selectedPubs.has(pub.id);
              const c = pub.color;
              return (
                <TouchableOpacity
                  key={pub.id}
                  style={[s.pubRow, sel && { borderColor: c + '60', backgroundColor: c + '0C' }]}
                  onPress={() => togglePub(pub.id)}
                  activeOpacity={0.7}
                >
                  <View style={[s.pubAvatar, { backgroundColor: c + '22', borderColor: c + '44' }]}>
                    <Text style={s.pubAvatarEmoji}>{pub.emoji}</Text>
                  </View>
                  <View style={s.pubMeta}>
                    <Text style={[s.pubName, sel && { color: c }]}>{pub.name}</Text>
                    <Text style={s.pubDesc} numberOfLines={1}>{pub.description}</Text>
                  </View>
                  <View style={[s.followBtn, sel && { backgroundColor: c }]}>
                    {sel
                      ? <Ionicons name="checkmark" size={16} color={colors.bgDeep} />
                      : <Text style={[s.followBtnText, { color: c }]}>+</Text>
                    }
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
          <View style={s.footer}>
            <TouchableOpacity
              style={s.primaryBtn}
              onPress={() => void finish(false)}
              disabled={loading}
              activeOpacity={0.85}
            >
              <LinearGradient colors={[colors.accentBright, colors.accent]} style={s.btnGrad}>
                <Text style={s.btnText}>{loading ? 'Setting up…' : 'Start reading'}</Text>
                {!loading && <Ionicons name="checkmark-done" size={18} color={colors.bgDeep} style={{ marginLeft: 6 }} />}
              </LinearGradient>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => void finish(true)} style={s.skipBtn}>
              <Text style={s.skipText}>Follow all & start reading</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </View>
  );
}

function createOnboardingStyles(colors: ReturnType<typeof useColors>) { return StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgDeep },
  header: { alignItems: 'center', paddingTop: 72, paddingBottom: 24 },
  logoRing: {
    width: 72, height: 72, borderRadius: 36,
    alignItems: 'center', justifyContent: 'center', marginBottom: 16,
    borderWidth: 1, borderColor: colors.accentBorder,
  },
  logoGlyph: { fontSize: 32, color: colors.accent },
  wordmark: { ...T.d1, color: colors.text, letterSpacing: 4, marginBottom: 6 },
  tagline: { ...T.body, color: colors.textSecondary },
  steps: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 32 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.border },
  dotActive: { width: 24, backgroundColor: colors.accent },
  sectionTitle: { ...T.h1, color: colors.text, textAlign: 'center', marginBottom: 6, paddingHorizontal: space.lg },
  sectionSub: { ...T.body, color: colors.textSecondary, textAlign: 'center', marginBottom: 24, paddingHorizontal: space.lg },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: space.md, gap: 10, paddingBottom: 120 },
  topicChip: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: radius.full, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  topicEmoji: { fontSize: 18, marginRight: 6 },
  topicLabel: { ...T.h3, color: colors.textSecondary },
  pubList: { paddingHorizontal: space.md, gap: 10, paddingBottom: 120 },
  pubRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: radius.lg,
    padding: 14, borderWidth: 1, borderColor: colors.border,
  },
  pubAvatar: {
    width: 48, height: 48, borderRadius: 24,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, marginRight: 12,
  },
  pubAvatarEmoji: { fontSize: 22 },
  pubMeta: { flex: 1 },
  pubName: { ...T.h3, color: colors.text, marginBottom: 2 },
  pubDesc: { ...T.caption, color: colors.textMuted },
  followBtn: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surfaceHigher, borderWidth: 1, borderColor: colors.border,
  },
  followBtnText: { fontSize: 20, fontWeight: '300', lineHeight: 22 },
  footer: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    paddingHorizontal: space.lg, paddingBottom: 40, paddingTop: 20,
    backgroundColor: colors.bgDeep + 'EE',
  },
  primaryBtn: { borderRadius: radius.lg, overflow: 'hidden', marginBottom: 10 },
  btnGrad: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 16, borderRadius: radius.lg,
  },
  btnText: { ...T.h2, color: colors.bgDeep },
  skipBtn: { alignItems: 'center', paddingVertical: 8 },
  skipText: { ...T.body, color: colors.textMuted },
}); }
