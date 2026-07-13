import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, FlatList, Image, ScrollView, StyleSheet,
  Text, TouchableOpacity, View, StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { format } from 'date-fns';

import { RootStackParamList } from '../../navigation';
import { type as T, space, radius, shadow } from '../../theme';
import { useColors } from '../../theme/ThemeContext';
import { PUBLICATIONS, TOPICS, Publication } from '../../data/publications';
import { fetchFeed, FeedItem } from '../../data/rss';
import {
  getFollowedIds, followPublication, upsertArticles,
  getArticlesForPublications, ArticleRow,
  upsertRemoteSource, getAllRemoteSources, RemoteSourceRow,
} from '../../data/db';
import { searchFeedlyByTopic, RemoteSource } from '../../data/feedSearch';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Tabs'>;

const PALETTE = [
  '#60A5FA', '#34D399', '#FBBF24', '#F472B6', '#A78BFA',
  '#EF4444', '#FB923C', '#4ADE80', '#38BDF8', '#E879F9',
];

function pickColor(seed: string): string {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h) ^ seed.charCodeAt(i);
  return PALETTE[(h >>> 0) % PALETTE.length];
}

function makeRemoteId(feedUrl: string): string {
  let h = 5381;
  for (let i = 0; i < feedUrl.length; i++) h = ((h << 5) + h) ^ feedUrl.charCodeAt(i);
  return 'remote_' + (h >>> 0).toString(36);
}

function articleId(pubId: string, link: string) { return `${pubId}::${link}`; }

function feedItemToRow(item: FeedItem, pubId: string): ArticleRow {
function feedItemToRow(item: FeedItem, pubId: string): ArticleRow {
  const link = item.link.startsWith('http://') ? item.link.replace('http://', 'https://') : item.link;
  return {
    id: articleId(pubId, link),
    publication_id: pubId,
    title: item.title,
    link,
    pub_date: item.pubDate.getTime(),
    excerpt: item.excerpt || null,
    content_html: item.contentHtml ?? null,
    image_url: item.imageUrl ?? null,
    word_count: null,
    fetched_at: Date.now(),
  };
}
  if (ts === 0) return '';
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (d === 0) return 'Today';
  if (d === 1) return 'Yesterday';
  if (d < 7) return `${d}d ago`;
  if (d < 30) return `${Math.floor(d / 7)}w ago`;
  return format(new Date(ts), 'MMM d');
}

interface PubMeta { name: string; color: string; emoji: string }

function getTopicPubs(topic: string, followed: Set<string>): Publication[] {
  if (topic === 'foryou') {
    const followedPubs = PUBLICATIONS.filter((p) => followed.has(p.id));
    const userTopics = new Set(followedPubs.flatMap((p) => p.topics));
    if (userTopics.size === 0) return PUBLICATIONS.filter((p) => !followed.has(p.id)).slice(0, 20);
    return PUBLICATIONS.filter((p) => p.topics.some((t) => userTopics.has(t)));
  }
  return PUBLICATIONS.filter((p) => p.topics.includes(topic));
}

const TOPIC_CHIPS = [
  { id: 'foryou', label: 'For You', emoji: '✨' },
  ...TOPICS,
];

export default function ExploreScreen() {
  const colors = useColors();
  const s = useMemo(() => createExploreStyles(colors), [colors]);
  const nav = useNavigation<Nav>();
  const [selectedTopic, setSelectedTopic] = useState('foryou');
  const [articles, setArticles] = useState<ArticleRow[]>([]);
  const [pubMetas, setPubMetas] = useState<Map<string, PubMeta>>(new Map());
  const [followedIds, setFollowedIds] = useState<Set<string>>(new Set());
  const [followingIds, setFollowingIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [remoteResults, setRemoteResults] = useState<RemoteSource[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const lastTopicRef = useRef('');

  useFocusEffect(
    useCallback(() => {
      void loadForTopic(selectedTopic);
    }, [selectedTopic]),
  );

  useEffect(() => {
    if (selectedTopic !== lastTopicRef.current) {
      lastTopicRef.current = selectedTopic;
      setRemoteResults([]);
      void loadRemote(selectedTopic);
    }
  }, [selectedTopic]);

  async function buildMetaMap(): Promise<Map<string, PubMeta>> {
    const map = new Map<string, PubMeta>();
    for (const p of PUBLICATIONS) map.set(p.id, { name: p.name, color: p.color, emoji: p.emoji });
    const remote = await getAllRemoteSources();
    for (const r of remote) map.set(r.id, { name: r.name, color: r.color, emoji: '📰' });
    return map;
  }

  async function loadForTopic(topic: string) {
    setLoading(true);
    try {
      const ids = await getFollowedIds();
      const followed = new Set(ids);
      setFollowedIds(followed);
      setPubMetas(await buildMetaMap());

      const topicPubs = getTopicPubs(topic, followed);
      // Fetch RSS for the top unfollowed local pubs so we have articles to show
      const unfollowed = topicPubs.filter((p) => !followed.has(p.id)).slice(0, 6);
      await Promise.allSettled(
        unfollowed.map(async (pub) => {
          try {
            const items = await fetchFeed(pub.feedUrl);
            await upsertArticles(items.slice(0, 8).map((item) => feedItemToRow(item, pub.id)));
          } catch {}
        }),
      );

      const rows = await getArticlesForPublications(topicPubs.map((p) => p.id));
      rows.sort((a, b) => b.pub_date - a.pub_date);
      setArticles(rows);
    } finally {
      setLoading(false);
    }
  }

  async function loadRemote(topic: string) {
    setRemoteLoading(true);
    try {
      setRemoteResults(await searchFeedlyByTopic(topic));
    } catch {
      setRemoteResults([]);
    } finally {
      setRemoteLoading(false);
    }
  }

  function addFollowed(id: string) {
    setFollowedIds((prev) => new Set(prev).add(id));
  }

  function removeFollowing(id: string) {
    setFollowingIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
  }

  async function handleFollow(pub: Publication) {
    if (followedIds.has(pub.id) || followingIds.has(pub.id)) return;
    setFollowingIds((prev) => new Set(prev).add(pub.id));
    try {
      await followPublication(pub.id);
      addFollowed(pub.id);
      fetchFeed(pub.feedUrl)
        .then((items) => upsertArticles(items.slice(0, 20).map((i) => feedItemToRow(i, pub.id))))
        .catch(() => {});
    } finally {
      removeFollowing(pub.id);
    }
  }

  async function handleFollowRemote(src: RemoteSource) {
    const id = makeRemoteId(src.feedUrl);
    if (followedIds.has(id) || followingIds.has(id)) return;
    setFollowingIds((prev) => new Set(prev).add(id));
    try {
      const color = pickColor(src.feedUrl);
      const row: RemoteSourceRow = {
        id, name: src.name, feed_url: src.feedUrl,
        description: src.description, color, added_at: Date.now(),
      };
      await upsertRemoteSource(row);
      await followPublication(id);
      addFollowed(id);
      setPubMetas((prev) => new Map(prev).set(id, { name: src.name, color, emoji: '📰' }));
      fetchFeed(src.feedUrl)
        .then((items) => upsertArticles(items.slice(0, 20).map((i) => feedItemToRow(i, id))))
        .catch(() => {});
    } finally {
      removeFollowing(id);
    }
  }

  const defaultMeta: PubMeta = { name: 'Unknown', color: colors.accent, emoji: '📰' };

  function renderArticle({ item, index }: { item: ArticleRow; index: number }) {
    const meta = pubMetas.get(item.publication_id) ?? defaultMeta;
    const isFollowed = followedIds.has(item.publication_id);
    const isFollowing = followingIds.has(item.publication_id);
    const localPub = PUBLICATIONS.find((p) => p.id === item.publication_id);
    const isHero = index === 0 || index % 8 === 0;
    const c = meta.color;

    return (
      <TouchableOpacity
        activeOpacity={0.85}
        style={s.articleCard}
        onPress={() => nav.navigate('Reader', { articleId: item.id, publicationId: item.publication_id })}
      >
        {isHero && item.image_url ? (
          <Image source={{ uri: item.image_url }} style={s.heroImg} resizeMode="cover" />
        ) : null}
        <View style={s.articleBody}>
          <View style={s.pubRow}>
            <View style={[s.pubDot, { backgroundColor: c }]} />
            <Text style={[s.pubName, { color: c }]} numberOfLines={1}>{meta.emoji} {meta.name}</Text>
            {!isFollowed ? (
              <TouchableOpacity
                onPress={() => localPub ? handleFollow(localPub) : undefined}
                style={[s.followChip, { borderColor: c + '66', backgroundColor: c + '18' }]}
                disabled={isFollowing || !localPub}
                hitSlop={8}
              >
                {isFollowing
                  ? <ActivityIndicator size={10} color={c} />
                  : <Text style={[s.followChipText, { color: c }]}>+ Follow</Text>
                }
              </TouchableOpacity>
            ) : (
              <View style={s.followingChip}>
                <Ionicons name="checkmark" size={10} color={colors.success} />
                <Text style={s.followingText}>Following</Text>
              </View>
            )}
          </View>
          <View style={s.contentRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.articleTitle} numberOfLines={isHero ? 4 : 3}>{item.title}</Text>
              {item.excerpt && !isHero ? (
                <Text style={s.excerpt} numberOfLines={2}>{item.excerpt}</Text>
              ) : null}
              {smartAge(item.pub_date) ? (
                <Text style={s.ageMeta}>{smartAge(item.pub_date)}</Text>
              ) : null}
            </View>
            {!isHero && item.image_url ? (
              <Image source={{ uri: item.image_url }} style={s.thumb} resizeMode="cover" />
            ) : null}
          </View>
        </View>
      </TouchableOpacity>
    );
  }

  function ListHeader() {
    return (
      <>
        <View style={s.header}>
          <View>
            <Text style={s.headerEyebrow}>DISCOVERY</Text>
            <Text style={s.headerTitle}>Explore</Text>
          </View>
          <View style={s.headerIcon}>
            <Ionicons name="planet-outline" size={24} color={colors.accent} />
          </View>
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.chipsRow}
        >
          {TOPIC_CHIPS.map((t) => {
            const active = selectedTopic === t.id;
            const topicColor = TOPICS.find((x) => x.id === t.id)?.color ?? colors.accent;
            return (
              <TouchableOpacity
                key={t.id}
                onPress={() => setSelectedTopic(t.id)}
                style={[s.chip, active && { backgroundColor: topicColor + '22', borderColor: topicColor + '66' }]}
              >
                <Text style={s.chipEmoji}>{t.emoji}</Text>
                <Text style={[s.chipLabel, active && { color: topicColor, fontWeight: '700' }]}>
                  {t.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
        {loading && (
          <View style={s.loadingRow}>
            <ActivityIndicator color={colors.accent} size="small" />
            <Text style={s.loadingText}>Finding articles…</Text>
          </View>
        )}
      </>
    );
  }

  function ListFooter() {
    return (
      <View style={s.moreSection}>
        <View style={s.moreDivider}>
          <View style={s.divLine} />
          <Ionicons name="globe-outline" size={14} color={colors.textMuted} style={{ marginHorizontal: 8 }} />
          <Text style={s.divLabel}>More around the web</Text>
          <View style={s.divLine} />
        </View>
        {remoteLoading ? (
          <ActivityIndicator color={colors.accent} style={{ marginVertical: space.xl }} />
        ) : remoteResults.length === 0 ? (
          <Text style={s.emptyRemote}>No external sources found</Text>
        ) : (
          remoteResults.map((src) => {
            const id = makeRemoteId(src.feedUrl);
            const isF = followedIds.has(id);
            const isFing = followingIds.has(id);
            const c = pickColor(src.feedUrl);
            return (
              <View key={src.feedUrl} style={s.sourceCard}>
                <View style={[s.sourceIconBox, { backgroundColor: c + '22' }]}>
                  <Text style={{ fontSize: 20 }}>📰</Text>
                </View>
                <View style={s.sourceInfo}>
                  <Text style={s.sourceName} numberOfLines={1}>{src.name}</Text>
                  {src.subscribers > 0 && (
                    <Text style={s.sourceSubs}>{src.subscribers.toLocaleString()} readers</Text>
                  )}
                  {src.description ? (
                    <Text style={s.sourceDesc} numberOfLines={2}>{src.description}</Text>
                  ) : null}
                </View>
                <TouchableOpacity
                  onPress={() => handleFollowRemote(src)}
                  disabled={isF || isFing}
                  style={[s.remoteBtn, isF && s.remoteBtnActive]}
                >
                  {isFing ? (
                    <ActivityIndicator size={12} color={isF ? colors.success : colors.accent} />
                  ) : (
                    <Text style={[s.remoteBtnText, isF && { color: colors.success }]}>
                      {isF ? '✓ Following' : '+ Follow'}
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            );
          })
        )}
        <View style={{ height: 100 }} />
      </View>
    );
  }

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bgDeep} />
      <LinearGradient colors={[colors.bgDeep, colors.bg]} style={StyleSheet.absoluteFill} />

      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <FlatList
          data={loading ? [] : articles}
          keyExtractor={(a) => a.id}
          renderItem={renderArticle}
          ListHeaderComponent={ListHeader}
          ListFooterComponent={ListFooter}
          ItemSeparatorComponent={() => <View style={s.sep} />}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 0 }}
          ListEmptyComponent={
            !loading ? (
              <View style={s.emptyArticles}>
                <Ionicons name="newspaper-outline" size={40} color={colors.textMuted} />
                <Text style={s.emptyText}>No articles found for this topic yet</Text>
              </View>
            ) : null
          }
        />
      </SafeAreaView>
    </View>
  );
}

function createExploreStyles(colors: ReturnType<typeof useColors>) { return StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgDeep },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm,
  },
  headerEyebrow: { ...T.label, color: colors.accent, marginBottom: 2 },
  headerTitle: { ...T.d2, color: colors.text },
  headerIcon: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: colors.accentMuted, borderWidth: 1, borderColor: colors.accentBorder,
    alignItems: 'center', justifyContent: 'center',
  },

  chipsRow: { paddingHorizontal: space.md, paddingBottom: space.md, gap: 8 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingVertical: 7, paddingHorizontal: 13,
    borderRadius: radius.full, borderWidth: 1,
    borderColor: colors.border, backgroundColor: colors.surface,
  },
  chipEmoji: { fontSize: 14 },
  chipLabel: { ...T.label, color: colors.textSecondary },

  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: space.lg, paddingVertical: space.md },
  loadingText: { ...T.body, color: colors.textMuted },

  articleCard: {
    marginHorizontal: space.md,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    overflow: 'hidden',
    ...shadow.card,
  },
  heroImg: { width: '100%', height: 190 },
  articleBody: { padding: space.md },
  pubRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  pubDot: { width: 7, height: 7, borderRadius: 4 },
  pubName: { ...T.label, flex: 1 },
  followChip: {
    paddingVertical: 3, paddingHorizontal: 10,
    borderRadius: radius.full, borderWidth: 1,
  },
  followChipText: { fontSize: 11, fontWeight: '700' },
  followingChip: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  followingText: { fontSize: 11, color: colors.success, fontWeight: '600' },
  contentRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  articleTitle: { ...T.h2, color: colors.text, marginBottom: 4, lineHeight: 22 },
  excerpt: { ...T.caption, color: colors.textMuted, lineHeight: 18 },
  ageMeta: { ...T.caption, color: colors.textMuted, marginTop: 6 },
  thumb: {
    width: 72, height: 72, borderRadius: radius.md,
    backgroundColor: colors.surfaceHigher,
  },
  sep: { height: 10 },

  emptyArticles: { alignItems: 'center', gap: space.md, paddingVertical: space.xl, paddingHorizontal: space.lg },
  emptyText: { ...T.body, color: colors.textMuted, textAlign: 'center' },

  moreSection: { paddingHorizontal: space.md, paddingTop: space.xl },
  moreDivider: { flexDirection: 'row', alignItems: 'center', marginBottom: space.lg },
  divLine: { flex: 1, height: 1, backgroundColor: colors.border },
  divLabel: { ...T.caption, color: colors.textMuted },
  emptyRemote: { ...T.caption, color: colors.textMuted, textAlign: 'center', marginVertical: space.lg },

  sourceCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: space.md, marginBottom: 10,
    ...shadow.card,
  },
  sourceIconBox: {
    width: 48, height: 48, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  sourceInfo: { flex: 1 },
  sourceName: { ...T.h3, color: colors.text, marginBottom: 2 },
  sourceSubs: { ...T.caption, color: colors.textMuted, marginBottom: 4 },
  sourceDesc: { ...T.caption, color: colors.textMuted, lineHeight: 17 },
  remoteBtn: {
    paddingVertical: 6, paddingHorizontal: 12,
    borderRadius: radius.full, borderWidth: 1, borderColor: colors.accentBorder,
    backgroundColor: colors.accentMuted, alignSelf: 'flex-start',
  },
  remoteBtnActive: { borderColor: colors.success + '66', backgroundColor: colors.success + '18' },
  remoteBtnText: { ...T.caption, color: colors.accent, fontWeight: '700' },
}); }
