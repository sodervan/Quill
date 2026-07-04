import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, DeviceEventEmitter, FlatList, ScrollView, StyleSheet,
  Text, TextInput, TouchableOpacity, View, StatusBar,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';

import { type as T, space, radius, shadow } from '../../theme';
import { useColors } from '../../theme/ThemeContext';
import { PUBLICATIONS, TOPICS } from '../../data/publications';
import {
  followPublication, getFollowedIds, unfollowPublication,
  upsertRemoteSource, getAllRemoteSources, RemoteSourceRow,
} from '../../data/db';
import { searchFeedly, RemoteSource } from '../../data/feedSearch';
import { fetchFeed, FeedItem } from '../../data/rss';
import { scrapeForArticles, deriveBlogUrl } from '../../data/scraper';
import { ArticleRow, upsertArticles } from '../../data/db';
import { FaviconAvatar } from '../../components/FaviconAvatar';

const PAGE_SIZE = 15;

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


function feedItemToRow(item: FeedItem, pubId: string): ArticleRow {
  return {
    id: `${pubId}::${item.link}`,
    publication_id: pubId,
    title: item.title,
    link: item.link,
    pub_date: item.pubDate.getTime(),
    excerpt: item.excerpt || null,
    content_html: item.contentHtml ?? null,
    image_url: item.imageUrl ?? null,
    word_count: null,
    fetched_at: Date.now(),
  };
}

export default function DiscoverScreen() {
  const colors = useColors();
  const s = useMemo(() => createDiscoverStyles(colors), [colors]);
  const [followedIds, setFollowedIds] = useState<Set<string>>(new Set());
  const [activeFilter, setActiveFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Auto recommendations
  const [recResults, setRecResults] = useState<RemoteSource[]>([]);
  const [recLoading, setRecLoading] = useState(false);

  // Feedly manual search
  const [webQuery, setWebQuery] = useState('');
  const [webResults, setWebResults] = useState<RemoteSource[]>([]);
  const [webLoading, setWebLoading] = useState(false);
  const [followingRemote, setFollowingRemote] = useState<Set<string>>(new Set());

  const loadFollowed = useCallback(async () => {
    const ids = await getFollowedIds();
    setFollowedIds(new Set(ids));
  }, []);

  useFocusEffect(useCallback(() => { void loadFollowed(); }, [loadFollowed]));
  useEffect(() => { void loadFollowed(); }, [loadFollowed]);

  useEffect(() => {
    const term = activeFilter
      ? (TOPICS.find((t) => t.id === activeFilter)?.label ?? activeFilter)
      : 'must read blogs';
    setRecResults([]);
    setRecLoading(true);
    searchFeedly(term, 14)
      .then((results) => {
        // Shuffle so order varies each visit
        setRecResults([...results].sort(() => Math.random() - 0.5));
      })
      .catch(() => setRecResults([]))
      .finally(() => setRecLoading(false));
  }, [activeFilter]);

  function refreshRecs() {
    const term = activeFilter
      ? (TOPICS.find((t) => t.id === activeFilter)?.label ?? activeFilter)
      : 'must read blogs';
    setRecResults([]);
    setRecLoading(true);
    searchFeedly(term, 14)
      .then((results) => setRecResults([...results].sort(() => Math.random() - 0.5)))
      .catch(() => setRecResults([]))
      .finally(() => setRecLoading(false));
  }

  const toggle = async (id: string) => {
    if (followedIds.has(id)) {
      await unfollowPublication(id);
      setFollowedIds((s) => { const n = new Set(s); n.delete(id); return n; });
    } else {
      await followPublication(id);
      setFollowedIds((s) => new Set([...s, id]));
    }
  };

  async function doWebSearch() {
    if (!webQuery.trim()) return;
    setWebLoading(true);
    setWebResults([]);
    try {
      setWebResults(await searchFeedly(webQuery.trim(), 12));
    } catch {
      setWebResults([]);
    } finally {
      setWebLoading(false);
    }
  }

  async function followRemote(src: RemoteSource) {
    const id = makeRemoteId(src.feedUrl);
    if (followedIds.has(id) || followingRemote.has(id)) return;
    setFollowingRemote((s) => new Set(s).add(id));
    try {
      const row: RemoteSourceRow = {
        id, name: src.name, feed_url: src.feedUrl,
        description: src.description, color: pickColor(src.feedUrl), added_at: Date.now(),
      };
      await upsertRemoteSource(row);
      await followPublication(id);
      setFollowedIds((s) => new Set(s).add(id));
      fetchFeed(src.feedUrl)
        .then(async (items) => {
          await upsertArticles(items.slice(0, 20).map((i) => feedItemToRow(i, id)));
          DeviceEventEmitter.emit('feedRefreshNeeded');
        })
        .catch(async () => {
          // RSS fetch failed — try scraping the blog page as fallback
          const blogUrl = deriveBlogUrl(src.feedUrl);
          if (!blogUrl) return;
          try {
            const { items: scraped } = await scrapeForArticles(blogUrl);
            if (scraped.length > 0) {
              await upsertArticles(scraped.slice(0, 20).map((i) => feedItemToRow(i, id)));
              DeviceEventEmitter.emit('feedRefreshNeeded');
            }
          } catch {}
        });
    } finally {
      setFollowingRemote((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  }

  const filtered = PUBLICATIONS.filter((p) => {
    if (activeFilter && !p.topics.includes(activeFilter)) return false;
    if (query.trim()) {
      const q = query.toLowerCase();
      return (
        p.name.toLowerCase().includes(q) ||
        p.author.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const visible = filtered.slice(0, visibleCount);
  const hasMore = visibleCount < filtered.length;

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bgDeep} />
      <LinearGradient colors={[colors.bgDeep, colors.bg]} style={StyleSheet.absoluteFill} />

      <FlatList
        data={visible}
        keyExtractor={(p) => p.id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={s.list}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View>
            <View style={s.header}>
              <View>
                <Text style={s.headerLabel}>BROWSE</Text>
                <Text style={s.headerTitle}>Discover</Text>
              </View>
              <View style={s.followingBadge}>
                <Ionicons name="people-outline" size={14} color={colors.accent} />
                <Text style={s.followingText}>{followedIds.size} following</Text>
              </View>
            </View>

            {/* ── Online recommendations ── */}
            {(recLoading || recResults.length > 0) && (
              <View style={s.recSection}>
                <View style={s.recHeader}>
                  <Ionicons name="globe-outline" size={13} color={colors.accent} />
                  <Text style={s.recTitle}>From the web</Text>
                  {recLoading
                    ? <ActivityIndicator size={10} color={colors.accent} style={{ marginLeft: 6 }} />
                    : (
                      <TouchableOpacity onPress={refreshRecs} hitSlop={8} style={{ marginLeft: 6 }}>
                        <Ionicons name="refresh-outline" size={14} color={colors.textMuted} />
                      </TouchableOpacity>
                    )
                  }
                </View>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={s.recRow}
                >
                  {recResults.map((src) => {
                    const id = makeRemoteId(src.feedUrl);
                    const isF = followedIds.has(id);
                    const isFing = followingRemote.has(id);
                    const c = pickColor(src.feedUrl);
                    const subLabel = src.subscribers >= 1000
                      ? `${Math.round(src.subscribers / 1000)}k readers`
                      : src.subscribers > 0 ? `${src.subscribers} readers` : null;
                    return (
                      <View key={src.feedUrl} style={s.recCard}>
                        <View style={s.recCardTop}>
                          <View style={[s.recAvatar, { backgroundColor: c + '22' }]}>
                            <FaviconAvatar feedUrl={src.feedUrl} emoji="📰" size={28} />
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={s.recName} numberOfLines={1}>{src.name}</Text>
                            {subLabel && <Text style={s.recSubs}>{subLabel}</Text>}
                          </View>
                        </View>
                        {src.description ? (
                          <Text style={s.recDesc} numberOfLines={3}>{src.description}</Text>
                        ) : null}
                        <TouchableOpacity
                          style={[s.recFollowBtn, { backgroundColor: isF ? colors.success + '20' : c, borderColor: isF ? colors.success + '60' : c }]}
                          onPress={() => followRemote(src)}
                          disabled={isF || isFing}
                        >
                          {isFing
                            ? <ActivityIndicator size={10} color={isF ? colors.success : colors.bgDeep} />
                            : <Ionicons name={isF ? 'checkmark' : 'add'} size={13} color={isF ? colors.success : colors.bgDeep} />
                          }
                          {!isFing && (
                            <Text style={[s.recFollowText, { color: isF ? colors.success : colors.bgDeep }]}>
                              {isF ? 'Following' : 'Follow'}
                            </Text>
                          )}
                        </TouchableOpacity>
                      </View>
                    );
                  })}
                </ScrollView>
              </View>
            )}

            <View style={s.searchRow}>
              <Ionicons name="search-outline" size={18} color={colors.textMuted} style={{ marginRight: 8 }} />
              <TextInput
                style={s.searchInput}
                placeholder="Search publications…"
                placeholderTextColor={colors.textMuted}
                value={query}
                onChangeText={(t) => { setQuery(t); setVisibleCount(PAGE_SIZE); }}
                returnKeyType="search"
              />
              {query.length > 0 && (
                <TouchableOpacity onPress={() => setQuery('')} hitSlop={8}>
                  <Ionicons name="close-circle" size={18} color={colors.textMuted} />
                </TouchableOpacity>
              )}
            </View>

            <FlatList
              horizontal
              data={[{ id: null as string | null, label: 'All', emoji: '✦', color: colors.accent }, ...TOPICS.map((t) => ({ ...t, id: t.id as string | null }))]}
              keyExtractor={(t) => String(t.id)}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={s.filterRow}
              renderItem={({ item }) => {
                const active = activeFilter === item.id;
                return (
                  <TouchableOpacity
                    style={[s.filterChip, active && { backgroundColor: item.color + '22', borderColor: item.color + '70' }]}
                    onPress={() => { setActiveFilter(active ? null : item.id); setVisibleCount(PAGE_SIZE); }}
                    activeOpacity={0.7}
                  >
                    <Text style={s.filterEmoji}>{item.emoji}</Text>
                    <Text style={[s.filterText, active && { color: item.color }]}>{item.label}</Text>
                  </TouchableOpacity>
                );
              }}
            />

            <Text style={s.resultCount}>
              {filtered.length} publication{filtered.length !== 1 ? 's' : ''}
              {activeFilter ? ` in ${TOPICS.find((t) => t.id === activeFilter)?.label}` : ''}
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const followed = followedIds.has(item.id);
          const c = item.color;
          return (
            <View style={s.card}>
              <LinearGradient colors={[c + '0A', 'transparent']} style={StyleSheet.absoluteFill} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} />
              <View style={[s.avatar, { backgroundColor: c + '18', borderColor: c + '40' }]}>
                <FaviconAvatar feedUrl={item.feedUrl} emoji={item.emoji} size={52} />
              </View>
              <View style={s.info}>
                <View style={s.nameRow}>
                  <Text style={s.pubName}>{item.name}</Text>
                  {followed && <View style={[s.dot, { backgroundColor: colors.success }]} />}
                </View>
                <Text style={s.pubAuthor}>{item.author}</Text>
                <Text style={s.pubDesc} numberOfLines={2}>{item.description}</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={s.topicRow}>
                  {item.topics.map((t) => {
                    const topic = TOPICS.find((x) => x.id === t);
                    return (
                      <View key={t} style={s.topicTag}>
                        <Text style={s.topicTagText}>{topic?.emoji} {topic?.label ?? t}</Text>
                      </View>
                    );
                  })}
                </ScrollView>
              </View>
              <TouchableOpacity
                style={[s.followBtn, followed ? { backgroundColor: c + '20', borderColor: c + '50' } : { backgroundColor: c, borderColor: c }]}
                onPress={() => toggle(item.id)}
                activeOpacity={0.8}
              >
                <Ionicons name={followed ? 'checkmark' : 'add'} size={18} color={followed ? c : colors.bgDeep} />
              </TouchableOpacity>
            </View>
          );
        }}
        ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
        ListFooterComponent={
          <View>
            {hasMore ? (
              <TouchableOpacity style={s.loadMore} onPress={() => setVisibleCount((n) => n + PAGE_SIZE)}>
                <LinearGradient colors={[colors.accentMuted, 'transparent']} style={StyleSheet.absoluteFill} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} />
                <Ionicons name="add-circle-outline" size={20} color={colors.accent} />
                <Text style={s.loadMoreText}>Load {Math.min(PAGE_SIZE, filtered.length - visibleCount)} more</Text>
              </TouchableOpacity>
            ) : (
              <View style={s.allLoaded}>
                <Text style={s.allLoadedText}>✦ All {filtered.length} curated sources shown</Text>
              </View>
            )}

            {/* ── Search the web for more ── */}
            <View style={s.webSection}>
              <View style={s.webDivider}>
                <View style={s.divLine} />
                <Ionicons name="globe-outline" size={14} color={colors.textMuted} style={{ marginHorizontal: 8 }} />
                <Text style={s.divLabel}>Search the web for more</Text>
                <View style={s.divLine} />
              </View>

              <View style={s.webSearchRow}>
                <Ionicons name="search-outline" size={16} color={colors.textMuted} style={{ marginRight: 8 }} />
                <TextInput
                  style={s.webSearchInput}
                  placeholder="e.g. climate science, fintech, indie dev…"
                  placeholderTextColor={colors.textMuted}
                  value={webQuery}
                  onChangeText={setWebQuery}
                  onSubmitEditing={doWebSearch}
                  returnKeyType="search"
                  autoCapitalize="none"
                />
                <TouchableOpacity onPress={doWebSearch} style={s.webSearchBtn} disabled={webLoading}>
                  {webLoading
                    ? <ActivityIndicator size={14} color={colors.accent} />
                    : <Text style={s.webSearchBtnText}>Search</Text>
                  }
                </TouchableOpacity>
              </View>

              {webResults.length > 0 && (
                <View style={{ marginTop: space.sm }}>
                  {webResults.map((src) => {
                    const id = makeRemoteId(src.feedUrl);
                    const isF = followedIds.has(id);
                    const isFing = followingRemote.has(id);
                    const c = pickColor(src.feedUrl);
                    return (
                      <View key={src.feedUrl} style={s.webCard}>
                        <View style={[s.webAvatar, { backgroundColor: c + '22' }]}>
                          <FaviconAvatar feedUrl={src.feedUrl} emoji="📰" size={44} />
                        </View>
                        <View style={s.webInfo}>
                          <Text style={s.webName} numberOfLines={1}>{src.name}</Text>
                          {src.subscribers > 0 && (
                            <Text style={s.webSubs}>{src.subscribers.toLocaleString()} readers</Text>
                          )}
                          {src.description ? (
                            <Text style={s.webDesc} numberOfLines={2}>{src.description}</Text>
                          ) : null}
                        </View>
                        <TouchableOpacity
                          onPress={() => followRemote(src)}
                          disabled={isF || isFing}
                          style={[s.webFollowBtn, isF && s.webFollowBtnActive]}
                        >
                          {isFing
                            ? <ActivityIndicator size={12} color={isF ? colors.success : colors.accent} />
                            : <Ionicons
                                name={isF ? 'checkmark' : 'add'}
                                size={18}
                                color={isF ? colors.success : colors.bgDeep}
                              />
                          }
                        </TouchableOpacity>
                      </View>
                    );
                  })}
                </View>
              )}
            </View>

            <View style={{ height: 100 }} />
          </View>
        }
      />
    </View>
  );
}

function createDiscoverStyles(colors: ReturnType<typeof useColors>) { return StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgDeep },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingTop: 60, paddingBottom: space.md,
  },
  headerLabel: { ...T.label, color: colors.accent, marginBottom: 2 },
  headerTitle: { ...T.d2, color: colors.text },
  followingBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.accentMuted, borderRadius: radius.full,
    paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: colors.accentBorder,
  },
  followingText: { ...T.badge, color: colors.accent },
  searchRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    marginBottom: space.md,
    paddingHorizontal: space.md, paddingVertical: 7,
  },
  searchInput: { flex: 1, fontSize: 14, color: colors.text },
  filterRow: { paddingBottom: space.sm, gap: 8 },
  filterChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: radius.full, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  filterEmoji: { fontSize: 14 },
  filterText: { ...T.caption, color: colors.textSecondary, fontWeight: '600' },
  resultCount: { ...T.caption, color: colors.textMuted, paddingBottom: space.sm },
  list: { paddingHorizontal: space.md, paddingBottom: 20 },
  card: {
    flexDirection: 'row', alignItems: 'flex-start',
    backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.md,
    borderWidth: 1, borderColor: colors.border, overflow: 'hidden', ...shadow.card,
  },
  avatar: {
    width: 52, height: 52, borderRadius: 26,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, marginRight: space.md, flexShrink: 0,
  },
  avatarEmoji: { fontSize: 24 },
  info: { flex: 1, marginRight: space.sm },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  pubName: { ...T.h3, color: colors.text },
  dot: { width: 6, height: 6, borderRadius: 3 },
  pubAuthor: { ...T.caption, color: colors.textMuted, marginBottom: 4 },
  pubDesc: { ...T.caption, color: colors.textSecondary, lineHeight: 18, marginBottom: 8 },
  topicRow: { flexDirection: 'row', gap: 4, paddingRight: 4 },
  topicTag: {
    borderRadius: radius.full, paddingHorizontal: 8, paddingVertical: 3, flexShrink: 0,
    backgroundColor: colors.surfaceHigher, borderWidth: 1, borderColor: colors.borderStrong,
  },
  topicTagText: { fontSize: 10, fontWeight: '600', color: colors.textSecondary },
  followBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, flexShrink: 0,
  },
  loadMore: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    marginTop: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.accentBorder,
    paddingVertical: 14, overflow: 'hidden',
  },
  loadMoreText: { ...T.h3, color: colors.accent },
  allLoaded: { alignItems: 'center', paddingVertical: space.lg },
  allLoadedText: { ...T.caption, color: colors.textMuted },

  // Auto recommendations
  recSection: { marginTop: space.sm, marginBottom: space.lg },
  recHeader: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 10 },
  recTitle: { ...T.label, color: colors.accent },
  recRow: { gap: 10, paddingRight: space.md },
  recCard: {
    width: 176, backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: 12,
    gap: 8, ...shadow.card,
  },
  recCardTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  recAvatar: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  recName: { fontSize: 13, fontWeight: '600' as const, color: colors.text },
  recSubs: { fontSize: 10, color: colors.textMuted, marginTop: 1 },
  recDesc: { fontSize: 12, color: colors.textSecondary, lineHeight: 17 },
  recFollowBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' as const,
    paddingVertical: 5, paddingHorizontal: 10,
    borderRadius: radius.full, borderWidth: 1,
  },
  recFollowText: { fontSize: 11, fontWeight: '700' as const },

  // Web search section
  webSection: { marginTop: space.xl, paddingHorizontal: 0 },
  webDivider: { flexDirection: 'row', alignItems: 'center', marginBottom: space.md },
  divLine: { flex: 1, height: 1, backgroundColor: colors.border },
  divLabel: { ...T.caption, color: colors.textMuted },
  webSearchRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: space.md, paddingVertical: 10,
    marginBottom: space.sm,
  },
  webSearchInput: { flex: 1, ...T.body, color: colors.text },
  webSearchBtn: {
    paddingVertical: 6, paddingHorizontal: 14,
    borderRadius: radius.full, backgroundColor: colors.accentMuted,
    borderWidth: 1, borderColor: colors.accentBorder,
  },
  webSearchBtnText: { ...T.caption, color: colors.accent, fontWeight: '700' },
  webCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: space.md, marginBottom: 8, ...shadow.card,
  },
  webAvatar: {
    width: 44, height: 44, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  webInfo: { flex: 1 },
  webName: { ...T.h3, color: colors.text, marginBottom: 2 },
  webSubs: { ...T.caption, color: colors.textMuted, marginBottom: 4 },
  webDesc: { ...T.caption, color: colors.textSecondary, lineHeight: 17 },
  webFollowBtn: {
    width: 34, height: 34, borderRadius: 17,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1,
    backgroundColor: colors.accent, borderColor: colors.accent, flexShrink: 0,
  },
  webFollowBtnActive: { backgroundColor: colors.success + '20', borderColor: colors.success + '60' },
}); }
