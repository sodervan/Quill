import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  StatusBar, ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { getSavedArticles, unsaveArticle, type ArticleRow, getRemoteMetaSync, getAllRemoteSources, getProgressBatch } from '../../data/db';
import { PUBLICATIONS } from '../../data/publications';
import { type as T, space, radius } from '../../theme';
import { useColors } from '../../theme/ThemeContext';
import { FaviconAvatar } from '../../components/FaviconAvatar';

type Props = { navigation: NativeStackNavigationProp<any> };

export default function LibraryScreen({ navigation }: Props) {
  const colors = useColors();
  const s = useMemo(() => createLibraryStyles(colors), [colors]);
  const [saved, setSaved] = useState<ArticleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [progressMap, setProgressMap] = useState<Map<string, number>>(new Map());

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        await getAllRemoteSources(); // populate remote meta cache
        const rows = await getSavedArticles();
        const prog = await getProgressBatch(rows.map((a) => a.id));
        if (active) { setSaved(rows); setProgressMap(prog); setLoading(false); }
      })();
      return () => { active = false; };
    }, []),
  );

  async function handleUnsave(articleId: string) {
    await unsaveArticle(articleId);
    setSaved((prev) => prev.filter((a) => a.id !== articleId));
  }

  const pubInfo = (item: ArticleRow) => {
    const p = PUBLICATIONS.find((x) => x.id === item.publication_id);
    if (p) return { name: p.name, color: p.color, emoji: p.emoji, iconUrl: item.link };
    const rm = getRemoteMetaSync(item.publication_id);
    return {
      name: rm?.name ?? item.publication_id,
      color: rm?.color ?? colors.accent,
      emoji: '📰',
      iconUrl: item.link,
    };
  };
  const readingTime = (wc: number | null) => wc ? `${Math.max(1, Math.ceil(wc / 200))} min` : '';
  const age = (ts: number) => {
    const d = Math.floor((Date.now() - ts) / 86400000);
    if (d === 0) return 'Today';
    if (d === 1) return 'Yesterday';
    return `${d}d ago`;
  };

  function openArticle(article: ArticleRow) {
    navigation.navigate('Reader', { articleId: article.id, publicationId: article.publication_id });
  }

  if (loading) {
    return (
      <View style={[s.root, { alignItems: 'center', justifyContent: 'center' }]}>
        <StatusBar barStyle="light-content" backgroundColor={colors.bgDeep} />
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bgDeep} />
      <LinearGradient colors={[colors.bgDeep, colors.bg]} style={StyleSheet.absoluteFill} />

      {/* Header */}
      <View style={s.header}>
        <Text style={s.headerTitle}>Library</Text>
        {saved.length > 0 && (
          <View style={s.countBadge}>
            <Text style={s.countText}>{saved.length}</Text>
          </View>
        )}
      </View>

      {saved.length === 0 ? (
        <View style={s.empty}>
          <LinearGradient
            colors={[colors.accentMuted, 'transparent']}
            style={s.emptyIconRing}
          >
            <Ionicons name="bookmark-outline" size={40} color={colors.accent} />
          </LinearGradient>
          <Text style={s.emptyTitle}>Nothing saved yet</Text>
          <Text style={s.emptySub}>Bookmark articles to read them later — even offline.</Text>
        </View>
      ) : (
        <FlatList
          data={saved}
          keyExtractor={(a) => a.id}
          contentContainerStyle={s.list}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => {
            const pi = pubInfo(item);
            const c = pi.color;
            const prog = progressMap.get(item.id) ?? 0;
            return (
              <TouchableOpacity
                style={s.card}
                onPress={() => openArticle(item)}
                activeOpacity={0.8}
              >
                <View style={s.cardInner}>
                  {/* Pub accent strip */}
                  <View style={[s.accentStrip, { backgroundColor: c }]} />

                  <View style={s.cardContent}>
                    <View style={s.cardTop}>
                      <View style={[s.pubChip, { backgroundColor: c + '18' }]}>
                        <FaviconAvatar feedUrl={pi.iconUrl} emoji={pi.emoji} size={14} />
                        <Text style={[s.pubChipText, { color: c }]}>
                          {pi.name}
                        </Text>
                      </View>
                      <Text style={s.metaAge}>{age(item.pub_date)}</Text>
                    </View>

                    <Text style={s.title} numberOfLines={3}>{item.title}</Text>

                    {item.excerpt ? (
                      <Text style={s.excerpt} numberOfLines={2}>{item.excerpt}</Text>
                    ) : null}

                    <View style={s.cardBottom}>
                      <View style={s.metaRow}>
                        {item.word_count ? (
                          <View style={s.metaPill}>
                            <Ionicons name="time-outline" size={12} color={colors.textMuted} />
                            <Text style={s.metaText}>{readingTime(item.word_count)}</Text>
                          </View>
                        ) : null}
                        <View style={s.metaPill}>
                          <Ionicons name="bookmark" size={12} color={colors.accent} />
                          <Text style={[s.metaText, { color: colors.accent }]}>Saved</Text>
                        </View>
                      </View>
                      <TouchableOpacity
                        style={s.unsaveBtn}
                        onPress={() => handleUnsave(item.id)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Ionicons name="bookmark" size={18} color={colors.accent} />
                      </TouchableOpacity>
                    </View>
                  </View>
                </View>
                {prog > 0.02 && (
                  <View style={s.progressTrack}>
                    <View style={[s.progressFill, { width: `${Math.round(prog * 100)}%` as any, backgroundColor: c }]} />
                  </View>
                )}
              </TouchableOpacity>
            );
          }}
        />
      )}
    </View>
  );
}

function createLibraryStyles(colors: ReturnType<typeof useColors>) { return StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgDeep },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingTop: 60, paddingHorizontal: space.lg, paddingBottom: space.md,
  },
  headerTitle: { ...T.d2, color: colors.text, flex: 1 },
  countBadge: {
    backgroundColor: colors.accentMuted, borderRadius: radius.full,
    paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: colors.accentBorder,
  },
  countText: { ...T.badge, color: colors.accent },
  empty: {
    flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.xl,
  },
  emptyIconRing: {
    width: 100, height: 100, borderRadius: 50,
    alignItems: 'center', justifyContent: 'center', marginBottom: space.lg,
  },
  emptyTitle: { ...T.h1, color: colors.text, marginBottom: space.sm, textAlign: 'center' },
  emptySub: { ...T.body, color: colors.textMuted, textAlign: 'center', lineHeight: 24 },
  list: { paddingHorizontal: space.md, paddingBottom: 100, gap: 12 },
  card: {
    borderRadius: radius.lg, overflow: 'hidden',
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  cardInner: { flexDirection: 'row' },
  accentStrip: { width: 3 },
  cardContent: { flex: 1, padding: space.md },
  cardTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 8 },
  pubChip: { flexDirection: 'row', alignItems: 'center', borderRadius: radius.full, paddingHorizontal: 8, paddingVertical: 3 },
  pubChipText: { ...T.badge, fontSize: 11 },
  metaAge: { ...T.caption, color: colors.textMuted, marginLeft: 'auto' },
  title: { ...T.h2, color: colors.text, lineHeight: 24, marginBottom: 6 },
  excerpt: { ...T.caption, color: colors.textSecondary, lineHeight: 18, marginBottom: 10 },
  cardBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  metaRow: { flexDirection: 'row', gap: 8 },
  metaPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: colors.surfaceHigher, borderRadius: radius.full,
    paddingHorizontal: 8, paddingVertical: 4,
  },
  metaText: { ...T.caption, color: colors.textMuted },
  unsaveBtn: { padding: 4 },
  progressTrack: { height: 3, backgroundColor: colors.surfaceHigher },
  progressFill: { height: 3 },
}); }
