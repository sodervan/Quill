import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, DeviceEventEmitter, FlatList, Keyboard, KeyboardAvoidingView, Modal, Platform,
  ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View, StatusBar,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';

import { type as T, space, radius, shadow } from '../../theme';
import { useColors } from '../../theme/ThemeContext';
import { PUBLICATIONS, TOPICS, type Publication } from '../../data/publications';
import {
  followPublication, getFollowedIds, unfollowPublication,
  upsertRemoteSource, getAllRemoteSources, RemoteSourceRow,
} from '../../data/db';
import { searchFeedly, RemoteSource } from '../../data/feedSearch';
import { fetchFeed, FeedItem } from '../../data/rss';
import { scrapeForArticles, deriveBlogUrl } from '../../data/scraper';
import { ArticleRow, upsertArticles } from '../../data/db';
import { FaviconAvatar } from '../../components/FaviconAvatar';
import { AppAlert } from '../../components/AppAlert';
import { db, auth } from '../../lib/firebase';

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
  const link = item.link.startsWith('http://') ? item.link.replace('http://', 'https://') : item.link;
  return {
    id: `${pubId}::${link}`,
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

export default function DiscoverScreen() {
  const colors = useColors();
  const s = useMemo(() => createDiscoverStyles(colors), [colors]);
  const [followedIds, setFollowedIds] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<'browse' | 'search'>('browse');
  const activeTabRef = useRef(activeTab);
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);
  const searchListRef = useRef<FlatList<RemoteSource>>(null);
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

  // Add by URL
  const [addUrl, setAddUrl] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  const [addStatus, setAddStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [addStatusMsg, setAddStatusMsg] = useState('');

  // Android's adjustResize is unreliable once a screen is deep inside a FlatList footer —
  // track the keyboard's real height ourselves and pad the scroll content by exactly that
  // much, so there's always genuine room to scroll the input above the keyboard.
  const [kbHeight, setKbHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const showSub = Keyboard.addListener('keyboardDidShow', (e) => {
      setKbHeight(e.endCoordinates.height);
      // Fires once the keyboard (and the extra padding it triggers) has actually
      // settled, so the scroll range is accurate — more reliable than a guessed delay.
      if (activeTabRef.current === 'search') {
        requestAnimationFrame(() => searchListRef.current?.scrollToEnd({ animated: true }));
      }
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => setKbHeight(0));
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  // Feed suggestion modal
  const [showSuggestModal, setShowSuggestModal] = useState(false);
  const [suggestUrl, setSuggestUrl] = useState('');
  const [suggestDescription, setSuggestDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

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
        website_url: src.websiteUrl ?? null,
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

  // Follow buttons for remote sources ("From the web" recs + Search Online results) used
  // to disable themselves once followed, with no way back — this toggles instead.
  async function toggleFollowRemote(src: RemoteSource) {
    const id = makeRemoteId(src.feedUrl);
    if (followingRemote.has(id)) return;
    if (!followedIds.has(id)) {
      await followRemote(src);
      return;
    }
    setFollowingRemote((s) => new Set(s).add(id));
    try {
      await unfollowPublication(id);
      setFollowedIds((s) => { const n = new Set(s); n.delete(id); return n; });
    } finally {
      setFollowingRemote((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  }

  async function addByUrl() {
    const raw = addUrl.trim();
    if (!raw) return;
    const url = raw.startsWith('http') ? raw : `https://${raw}`;
    setAddLoading(true);
    setAddStatus('idle');
    setAddStatusMsg('');
    try {
      // 1. Try the URL directly as an RSS feed
      let items = await fetchFeed(url).catch(() => null);
      let feedUrl = url;
      let feedName = '';

      if (!items || items.length === 0) {
        // 2. Try scraping the page for feed links / articles
        const blogUrl = deriveBlogUrl(url) ?? url;
        const { items: scraped } = await scrapeForArticles(blogUrl).catch(() => ({ items: [] as FeedItem[] }));
        if (scraped.length === 0) {
          setAddStatus('error');
          setAddStatusMsg('Could not find a feed at that URL. Try pasting the RSS feed link directly.');
          return;
        }
        items = scraped;
        feedUrl = blogUrl;
      }

      // Derive a name from the URL hostname if we don't have one yet
      try { feedName = new URL(feedUrl).hostname.replace(/^www\./, ''); } catch { feedName = feedUrl; }

      const src: import('../../data/feedSearch').RemoteSource = {
        name: feedName,
        feedUrl,
        description: '',
        subscribers: 0,
        websiteUrl: feedUrl,
      };
      await followRemote(src);

      // Log to Firebase if signed in
      if (auth.currentUser) {
        addDoc(collection(db, 'feed_adds'), {
          userId: auth.currentUser.uid,
          feedUrl,
          addedAt: serverTimestamp(),
          source: 'add_by_url',
        }).catch(() => {});
      }

      setAddStatus('success');
      setAddStatusMsg(`Now following ${feedName}`);
      setAddUrl('');
    } catch {
      setAddStatus('error');
      setAddStatusMsg('Something went wrong. Check the URL and try again.');
    } finally {
      setAddLoading(false);
    }
  }

  async function submitFeedSuggestion() {
    if (!suggestUrl.trim()) {
      AppAlert.alert('Missing URL', 'Please enter a feed URL');
      return;
    }

    // Basic URL validation
    const urlPattern = /^https?:\/\/.+/i;
    if (!urlPattern.test(suggestUrl.trim())) {
      AppAlert.alert('Invalid URL', 'Please enter a valid URL starting with http:// or https://');
      return;
    }

    // No sign-in requirement — this app fully supports offline/guest use elsewhere
    // (reading, saving, highlighting all work without an account), so suggestions
    // shouldn't be gated behind one either. Attribute to the account when signed in.
    setSubmitting(true);
    try {
      await addDoc(collection(db, 'feed_suggestions'), {
        userId: auth.currentUser?.uid ?? null,
        userEmail: auth.currentUser?.email ?? null,
        feedUrl: suggestUrl.trim(),
        description: suggestDescription.trim() || null,
        status: 'pending',
        submittedAt: serverTimestamp(),
      });

      AppAlert.alert(
        'Thanks! 🎉',
        `Your feed suggestion has been submitted. We'll review it and add it if it's a good fit.`,
        [{ text: 'OK' }]
      );

      // Reset form and close modal
      setSuggestUrl('');
      setSuggestDescription('');
      setShowSuggestModal(false);
    } catch (error: any) {
      console.error('Failed to submit feed suggestion:', error);
      const isPermissionError = error?.code === 'permission-denied';
      AppAlert.alert(
        'Error',
        isPermissionError
          ? "We couldn't submit that — this feature isn't fully set up on our end yet. Sorry about that!"
          : 'Failed to submit your suggestion. Check your connection and try again.',
      );
    } finally {
      setSubmitting(false);
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

  function renderPubItem({ item }: { item: Publication }) {
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
                  {topic?.emoji ? <Text style={s.topicTagEmoji}>{topic.emoji}</Text> : null}
                  <Text style={s.topicTagText}>{topic?.label ?? t}</Text>
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
  }

  function renderWebItem({ item: src }: { item: RemoteSource }) {
    const id = makeRemoteId(src.feedUrl);
    const isF = followedIds.has(id);
    const isFing = followingRemote.has(id);
    const c = pickColor(src.feedUrl);
    return (
      <View style={s.webCard}>
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
          onPress={() => toggleFollowRemote(src)}
          disabled={isFing}
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
  }

  // Shared across both tabs — header + "From the web" recs + the tab switcher itself,
  // followed by the tab-specific search control (curated search+filters vs. web search box).
  const sharedHeader = (
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
                  <View style={{ gap: 8 }}>
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
                  </View>
                  <TouchableOpacity
                    style={[s.recFollowBtn, { backgroundColor: isF ? colors.success + '20' : c, borderColor: isF ? colors.success + '60' : c }]}
                    onPress={() => toggleFollowRemote(src)}
                    disabled={isFing}
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

      {/* ── Browse curated / Search online tabs ── */}
      <View style={s.tabRow}>
        <TouchableOpacity
          style={[s.tabBtn, activeTab === 'browse' && s.tabBtnActive]}
          onPress={() => setActiveTab('browse')}
        >
          <Ionicons name="library-outline" size={15} color={activeTab === 'browse' ? colors.accent : colors.textMuted} />
          <Text style={[s.tabLabel, activeTab === 'browse' && { color: colors.accent }]}>Browse</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.tabBtn, activeTab === 'search' && s.tabBtnActive]}
          onPress={() => setActiveTab('search')}
        >
          <Ionicons name="globe-outline" size={15} color={activeTab === 'search' ? colors.accent : colors.textMuted} />
          <Text style={[s.tabLabel, activeTab === 'search' && { color: colors.accent }]}>Search Online</Text>
        </TouchableOpacity>
      </View>

      {activeTab === 'browse' ? (
        <>
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
        </>
      ) : (
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
      )}
    </View>
  );

  // Persistent regardless of tab — suggesting a feed is equally relevant whether
  // you were browsing the curated list or searching online and came up empty.
  const suggestFeedBtn = (
    <TouchableOpacity
      style={s.suggestBtn}
      onPress={() => setShowSuggestModal(true)}
      activeOpacity={0.8}
    >
      <LinearGradient
        colors={[colors.accent + '15', colors.accent + '08']}
        style={StyleSheet.absoluteFill}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
      />
      <Ionicons name="bulb-outline" size={18} color={colors.accent} />
      <Text style={s.suggestBtnText}>Suggest a Feed</Text>
      <Text style={s.suggestBtnSub}>Help us expand our catalog</Text>
    </TouchableOpacity>
  );

  const browseFooter = (
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
      {suggestFeedBtn}
      <View style={{ height: 100 }} />
    </View>
  );

  // Add by URL lives here — it's the fallback for when searching online doesn't
  // turn up the feed you already have a direct link to.
  const searchFooter = (
    <View>
      <View style={[s.addUrlCard, webResults.length === 0 && { marginTop: 0 }]}>
        <LinearGradient
          colors={[colors.accent + '12', 'transparent']}
          style={StyleSheet.absoluteFill}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
        />
        <View style={s.addUrlHeader}>
          <Ionicons name="link-outline" size={16} color={colors.accent} />
          <Text style={s.addUrlTitle}>Add by URL</Text>
          <Text style={s.addUrlSub}>Paste any blog or RSS feed link</Text>
        </View>
        <View style={s.addUrlRow}>
          <TextInput
            style={s.addUrlInput}
            placeholder="https://example.com/feed"
            placeholderTextColor={colors.textMuted}
            value={addUrl}
            onChangeText={(t) => { setAddUrl(t); setAddStatus('idle'); }}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            onSubmitEditing={addByUrl}
          />
          <TouchableOpacity
            style={[s.addUrlBtn, addLoading && { opacity: 0.6 }]}
            onPress={addByUrl}
            disabled={addLoading}
          >
            {addLoading
              ? <ActivityIndicator size={14} color={colors.bgDeep} />
              : <Ionicons name="arrow-forward" size={16} color={colors.bgDeep} />
            }
          </TouchableOpacity>
        </View>
        {addStatus !== 'idle' && (
          <View style={[s.addStatusRow, { backgroundColor: addStatus === 'success' ? colors.success + '18' : colors.danger + '18' }]}>
            <Ionicons
              name={addStatus === 'success' ? 'checkmark-circle' : 'alert-circle-outline'}
              size={14}
              color={addStatus === 'success' ? colors.success : colors.danger}
            />
            <Text style={[s.addStatusText, { color: addStatus === 'success' ? colors.success : colors.danger }]}>
              {addStatusMsg}
            </Text>
          </View>
        )}
      </View>

      {suggestFeedBtn}
      <View style={{ height: 100 }} />
    </View>
  );

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bgDeep} />
      <LinearGradient colors={[colors.bgDeep, colors.bg]} style={StyleSheet.absoluteFill} />

      {activeTab === 'browse' ? (
        <FlatList
          data={visible}
          keyExtractor={(p) => p.id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={s.list}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={sharedHeader}
          renderItem={renderPubItem}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          ListFooterComponent={browseFooter}
        />
      ) : (
        <FlatList
          ref={searchListRef}
          data={webResults}
          keyExtractor={(src) => src.feedUrl}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[s.list, kbHeight > 0 && { paddingBottom: 20 + kbHeight }]}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={sharedHeader}
          renderItem={renderWebItem}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          ListEmptyComponent={!webLoading ? (
            <View style={s.searchEmpty}>
              <Ionicons name="search-outline" size={30} color={colors.textMuted} />
              <Text style={s.searchEmptyText}>
                {webQuery.trim()
                  ? 'No results — try a different search, or paste the feed URL directly below.'
                  : 'Search for a topic, blog, or publication name to find feeds from around the web.'}
              </Text>
            </View>
          ) : null}
          ListFooterComponent={searchFooter}
        />
      )}

      {/* ── Feed Suggestion Modal ── */}
      <Modal
        visible={showSuggestModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowSuggestModal(false)}
      >
        {/* Inside a Modal, Android's adjustResize (which normal screens rely on) doesn't
            apply — Modal opens its own native window. 'height' is the fix that actually
            works here; 'undefined' (fine on the root screen) would leave inputs uncovered. */}
        <KeyboardAvoidingView
          style={s.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setShowSuggestModal(false)}
          />
          <View style={s.modalContent}>
            <View style={s.modalHeader}>
              <View style={s.modalTitleRow}>
                <Ionicons name="bulb-outline" size={22} color={colors.accent} />
                <Text style={s.modalTitle}>Suggest a Feed</Text>
              </View>
              <TouchableOpacity onPress={() => setShowSuggestModal(false)} hitSlop={8}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </TouchableOpacity>
            </View>

            <Text style={s.modalDesc}>
              Know a great blog or publication we should add? Share the feed URL and we'll review it.
            </Text>

            <View style={s.formGroup}>
              <Text style={s.formLabel}>Feed URL *</Text>
              <View style={s.inputWrapper}>
                <Ionicons name="link-outline" size={16} color={colors.textMuted} style={{ marginRight: 8 }} />
                <TextInput
                  style={s.input}
                  placeholder="https://example.com/feed"
                  placeholderTextColor={colors.textMuted}
                  value={suggestUrl}
                  onChangeText={setSuggestUrl}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  returnKeyType="next"
                />
              </View>
            </View>

            <View style={s.formGroup}>
              <Text style={s.formLabel}>Why should we add it? (optional)</Text>
              <View style={[s.inputWrapper, { alignItems: 'flex-start', paddingVertical: 10 }]}>
                <TextInput
                  style={[s.input, { height: 80, textAlignVertical: 'top' }]}
                  placeholder="Tell us what makes this feed special..."
                  placeholderTextColor={colors.textMuted}
                  value={suggestDescription}
                  onChangeText={setSuggestDescription}
                  multiline
                  numberOfLines={4}
                  maxLength={300}
                  returnKeyType="done"
                />
              </View>
              <Text style={s.charCount}>{suggestDescription.length}/300</Text>
            </View>

            <TouchableOpacity
              style={[s.submitBtn, submitting && { opacity: 0.6 }]}
              onPress={submitFeedSuggestion}
              disabled={submitting}
              activeOpacity={0.8}
            >
              <LinearGradient
                colors={[colors.accent, colors.accent + 'CC']}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
              />
              {submitting ? (
                <ActivityIndicator size={20} color={colors.bgDeep} />
              ) : (
                <>
                  <Ionicons name="paper-plane-outline" size={18} color={colors.bgDeep} />
                  <Text style={s.submitBtnText}>Submit Suggestion</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </KeyboardAvoidingView>
  );
}

function createDiscoverStyles(colors: ReturnType<typeof useColors>) { return StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgDeep },
  header: {
    // No horizontal padding here — this sits inside the FlatList's ListHeaderComponent,
    // which already gets paddingHorizontal from `list` below. Adding more here double-pads
    // it against the outer edge, throwing it out of alignment with everything below it.
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 60, paddingBottom: space.md,
  },
  headerLabel: { ...T.label, color: colors.accent, marginBottom: 2 },
  headerTitle: { ...T.d2, color: colors.text },
  followingBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.accentMuted, borderRadius: radius.full,
    paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: colors.accentBorder,
  },
  followingText: { ...T.badge, color: colors.accent },

  // Browse / Search Online tabs
  tabRow: {
    flexDirection: 'row', marginBottom: space.md,
    backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: 4, gap: 4,
  },
  tabBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 9, borderRadius: radius.md,
  },
  tabBtnActive: { backgroundColor: colors.surfaceHigher },
  tabLabel: { ...T.label, color: colors.textMuted, fontWeight: '600' },

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
    flexDirection: 'row', alignItems: 'center', gap: 3,
    borderRadius: radius.full, paddingHorizontal: 8, paddingVertical: 3, flexShrink: 0,
    backgroundColor: colors.surfaceHigher, borderWidth: 1, borderColor: colors.borderStrong,
  },
  topicTagEmoji: { fontSize: 11, lineHeight: 14 },
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
    width: 176, height: 156, backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: 12,
    ...shadow.card,
  },
  recCardTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  recAvatar: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  recName: { fontSize: 13, fontWeight: '600' as const, color: colors.text },
  recSubs: { fontSize: 10, color: colors.textMuted, marginTop: 1 },
  recDesc: { fontSize: 12, color: colors.textSecondary, lineHeight: 17 },
  recFollowBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' as const,
    marginTop: 'auto' as const,
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
  searchEmpty: {
    alignItems: 'center', justifyContent: 'center',
    paddingVertical: space.xl, paddingHorizontal: space.lg, gap: 10,
  },
  searchEmptyText: { ...T.caption, color: colors.textMuted, textAlign: 'center', lineHeight: 19 },
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

  // Add by URL card
  addUrlCard: {
    marginTop: space.lg, borderRadius: radius.lg, overflow: 'hidden',
    borderWidth: 1, borderColor: colors.accentBorder,
    padding: space.md, gap: 10, ...shadow.card,
    backgroundColor: colors.surface,
  },
  addUrlHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  addUrlTitle: { ...T.h3, color: colors.accent },
  addUrlSub: { ...T.caption, color: colors.textMuted, marginLeft: 'auto' },
  addUrlRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  addUrlInput: {
    flex: 1, ...T.body, color: colors.text,
    backgroundColor: colors.bg, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 10, paddingVertical: 9,
    fontSize: 13,
  },
  addUrlBtn: {
    width: 38, height: 38, borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  addStatusRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 7,
  },
  addStatusText: { ...T.caption, flex: 1, fontWeight: '600' },

  // Suggest feed button
  suggestBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    marginTop: space.sm, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.accentBorder,
    paddingVertical: 16, paddingHorizontal: 20, gap: 10,
    overflow: 'hidden', ...shadow.card,
  },
  suggestBtnText: { ...T.h3, color: colors.accent, marginRight: 'auto' },
  suggestBtnSub: { ...T.caption, color: colors.textMuted, fontStyle: 'italic' },

  // Modal styles
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center', alignItems: 'center', padding: space.lg,
  },
  modalContent: {
    width: '100%', maxWidth: 500,
    backgroundColor: colors.surface, borderRadius: radius.xl,
    padding: space.lg, borderWidth: 1, borderColor: colors.border,
    ...shadow.card,
  },
  modalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: space.md,
  },
  modalTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  modalTitle: { ...T.d3, color: colors.text },
  modalDesc: { ...T.body, color: colors.textSecondary, marginBottom: space.lg, lineHeight: 22 },
  formGroup: { marginBottom: space.md },
  formLabel: { ...T.caption, color: colors.textMuted, marginBottom: 6, fontWeight: '600' },
  inputWrapper: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.bg, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: space.md, paddingVertical: 12,
  },
  input: { flex: 1, ...T.body, color: colors.text },
  charCount: { ...T.caption, color: colors.textMuted, textAlign: 'right', marginTop: 4 },
  submitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: radius.lg,
    overflow: 'hidden', marginTop: space.sm,
  },
  submitBtnText: { ...T.h3, color: colors.bgDeep, fontWeight: '700' },
}); }
