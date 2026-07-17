import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, DeviceEventEmitter, Dimensions, FlatList,
  Image, Linking, Modal, NativeScrollEvent, NativeSyntheticEvent, PanResponder,
  RefreshControl, ScrollView, Share, StyleSheet, Text, TextInput, TouchableOpacity, View, StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { format } from 'date-fns';
import * as Haptics from 'expo-haptics';

import { RootStackParamList } from '../../navigation';
import { type as T, space, radius, shadow } from '../../theme';
import { useColors } from '../../theme/ThemeContext';
import { AppAlert } from '../../components/AppAlert';
import { PUBLICATIONS } from '../../data/publications';
import { fetchFeed, fetchFeedPage, FeedItem } from '../../data/rss';
import { scrapeForArticles, deriveBlogUrl } from '../../data/scraper';
import {
  getFollowedIds, followPublication, unfollowPublication,
  mutePublication, unmutePublication, getMutedIds,
  upsertArticles, getArticlesForPublications, ArticleRow,
  isArticleSaved, saveArticle, unsaveArticle, getSavedIds,
  getAllRemoteSources, getRemoteMetaSync, getProgressBatch, toggleArticleRead,
} from '../../data/db';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Tabs'>;

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const HALF_W = SCREEN_W / 2;
const SWIPE_THRESHOLD = 88;
const SCROLL_TOP_THRESHOLD = 400;
const PUB_SEARCH_H = Math.min(560, SCREEN_H * 0.75);
// Each chip loads a remote favicon — capping how many mount inline keeps the row itself
// fast even with hundreds of follows; the search sheet (FlatList, virtualized) is the
// path for finding anything past this cap.
const CHIP_ROW_CAP = 30;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function articleId(pubId: string, link: string) { return `${pubId}::${link}`; }

function feedItemToRow(item: FeedItem, pubId: string): ArticleRow {
  const rawExcerpt = item.excerpt || null;
  // Upgrade http:// article links to https:// — tracking/redirect URLs like
  // rss.desiringgod.org use HTTP and fail on Android release builds
  const link = item.link.startsWith('http://') ? item.link.replace('http://', 'https://') : item.link;
  return {
    id: articleId(pubId, link),
    publication_id: pubId,
    title: item.title,
    link,
    pub_date: item.pubDate.getTime(),
    excerpt: rawExcerpt ? stripHtml(rawExcerpt) : null,
    content_html: item.contentHtml ?? null,
    image_url: item.imageUrl ?? null,
    word_count: null,
    fetched_at: Date.now(),
  };
}

function readingTime(wc: number | null) {
  if (!wc) return null;
  return `${Math.max(1, Math.round(wc / 200))} min`;
}

function smartAge(ts: number): string {
  if (ts === 0) return '';
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (d === 0) return 'Today';
  if (d === 1) return 'Yesterday';
  if (d < 7) return `${d}d ago`;
  if (d < 30) return `${Math.floor(d / 7)}w ago`;
  return format(new Date(ts), 'MMM d');
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function dailySeed(): number {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

function seededRng(seed: number) {
  let s = seed | 0;
  return () => {
    s = Math.imul(s ^ (s >>> 15), s | 1);
    s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
    return ((s ^ (s >>> 14)) >>> 0) / 0x100000000;
  };
}

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const rng = seededRng(seed);
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function interleave(articles: ArticleRow[], seed?: number): ArticleRow[] {
  const byPub = new Map<string, ArticleRow[]>();
  for (const a of articles) {
    if (!byPub.has(a.publication_id)) byPub.set(a.publication_id, []);
    byPub.get(a.publication_id)!.push(a);
  }
  const rawQueues = [...byPub.values()];
  const queues = seed !== undefined ? seededShuffle(rawQueues, seed) : rawQueues;
  const result: ArticleRow[] = [];
  let i = 0;
  while (queues.some((q) => q.length > 0)) {
    const q = queues[i % queues.length];
    if (q.length > 0) result.push(q.shift()!);
    i++;
  }
  return result;
}

// ─── FaviconIcon ─────────────────────────────────────────────────────────────

function FaviconIcon({ feedUrl, emoji, size }: { feedUrl: string; emoji: string; size: number }) {
  const [failed, setFailed] = useState(false);
  const uri = React.useMemo(() => {
    try {
      const { hostname } = new URL(feedUrl);
      return `https://www.google.com/s2/favicons?domain=${hostname}&sz=64`;
    } catch { return ''; }
  }, [feedUrl]);

  if (uri && !failed) {
    return (
      <Image
        source={{ uri }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        onError={() => setFailed(true)}
      />
    );
  }
  return <Text style={{ fontSize: size - 2, lineHeight: size }}>{emoji}</Text>;
}

// ─── SwipeableCard ────────────────────────────────────────────────────────────

function SwipeableCard({
  children,
  onSwipeRight,
  onSwipeLeft,
  isSaved,
}: {
  children: React.ReactNode;
  onSwipeRight?: () => void;
  onSwipeLeft?: () => void;
  isSaved?: boolean;
}) {
  const colors = useColors();
  const s = useMemo(() => createFeedStyles(colors), [colors]);
  const translateX = useRef(new Animated.Value(0)).current;
  const hapticFired = useRef(false);

  // PanResponder.create() below runs inside useRef, so it's only ever built once, on this
  // card's first render — its callbacks would otherwise permanently close over that first
  // render's onSwipeRight/onSwipeLeft (and whatever state, like savedIds, those closed over
  // at the time). Keeping the latest callbacks in refs and calling through them means every
  // swipe — not just the first — sees current state (e.g. correctly toggling save/unsave).
  const onSwipeRightRef = useRef(onSwipeRight);
  const onSwipeLeftRef = useRef(onSwipeLeft);
  useEffect(() => {
    onSwipeRightRef.current = onSwipeRight;
    onSwipeLeftRef.current = onSwipeLeft;
  });

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gs) =>
        Math.abs(gs.dx) > 6 &&
        Math.abs(gs.dx) > Math.abs(gs.dy) * 1.8 &&
        Math.abs(gs.dy) < 20,
      onPanResponderGrant: () => { hapticFired.current = false; },
      onPanResponderMove: (_, gs) => {
        translateX.setValue(gs.dx);
        if (!hapticFired.current && Math.abs(gs.dx) >= SWIPE_THRESHOLD) {
          hapticFired.current = true;
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        }
      },
      onPanResponderRelease: (_, gs) => {
        if (gs.dx >= SWIPE_THRESHOLD) onSwipeRightRef.current?.();
        else if (gs.dx <= -SWIPE_THRESHOLD) onSwipeLeftRef.current?.();
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true, tension: 120, friction: 12 }).start();
      },
      onPanResponderTerminate: () => {
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
      },
      onPanResponderTerminationRequest: () => true,
    })
  ).current;

  const saveOpacity = translateX.interpolate({ inputRange: [0, SWIPE_THRESHOLD], outputRange: [0, 1], extrapolate: 'clamp' });
  const hideOpacity = translateX.interpolate({ inputRange: [-SWIPE_THRESHOLD, 0], outputRange: [1, 0], extrapolate: 'clamp' });
  const saveScale = translateX.interpolate({ inputRange: [0, SWIPE_THRESHOLD], outputRange: [0.6, 1], extrapolate: 'clamp' });
  const hideScale = translateX.interpolate({ inputRange: [-SWIPE_THRESHOLD, 0], outputRange: [1, 0.6], extrapolate: 'clamp' });

  return (
    <View style={{ overflow: 'hidden', borderRadius: radius.lg }}>
      <Animated.View style={[s.swipeBg, isSaved ? s.swipeUnsaveBg : s.swipeSaveBg, { opacity: saveOpacity }]}>
        <Animated.View style={{ transform: [{ scale: saveScale }], alignItems: 'center', gap: 4 }}>
          <Ionicons name={isSaved ? 'bookmark-outline' : 'bookmark'} size={26} color="white" />
          <Text style={s.swipeLabel}>{isSaved ? 'Remove' : 'Save'}</Text>
        </Animated.View>
      </Animated.View>
      <Animated.View style={[s.swipeBg, s.swipeHideBg, { opacity: hideOpacity }]}>
        <Animated.View style={{ transform: [{ scale: hideScale }], alignItems: 'center', gap: 4 }}>
          <Ionicons name="eye-off-outline" size={26} color="white" />
          <Text style={s.swipeLabel}>Hide</Text>
        </Animated.View>
      </Animated.View>
      <Animated.View style={{ transform: [{ translateX }] }} {...pan.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}

// ─── HeroCard ─────────────────────────────────────────────────────────────────

function HeroCardInner({
  article, onPress, onLongPress, showFollow, onFollow, isFollowing, isSaved, progress,
}: {
  article: ArticleRow;
  onPress: () => void;
  onLongPress: () => void;
  showFollow?: boolean;
  onFollow?: () => void;
  isFollowing?: boolean;
  isSaved?: boolean;
  progress: number;
}) {
  const colors = useColors();
  const s = useMemo(() => createFeedStyles(colors), [colors]);
  const pub = PUBLICATIONS.find((p) => p.id === article.publication_id);
  const remoteMeta = pub ? null : getRemoteMetaSync(article.publication_id);
  const c = pub?.color ?? remoteMeta?.color ?? colors.accent;
  const pubName = pub?.name ?? remoteMeta?.name ?? 'Source';
  const feedUrl = article.link;

  return (
    <TouchableOpacity style={s.hero} onPress={onPress} onLongPress={onLongPress} activeOpacity={0.85} delayLongPress={380}>
      <LinearGradient colors={[c + '1A', c + '06', 'transparent']} style={StyleSheet.absoluteFill} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} />

      <View style={s.heroPubRow}>
        <View style={[s.pubPill, { backgroundColor: c + '1A', borderColor: c + '44' }]}>
          <FaviconIcon feedUrl={feedUrl} emoji={pub?.emoji ?? '📰'} size={18} />
          <Text style={[s.pubPillText, { color: c }]} numberOfLines={1}>{pubName.toUpperCase()}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {isSaved && <Ionicons name="bookmark" size={16} color={colors.accent} />}
          {showFollow && (
            <TouchableOpacity
              onPress={onFollow}
              style={[s.inlineFollowBtn, { borderColor: c + '66', backgroundColor: c + '18' }]}
              disabled={isFollowing}
              hitSlop={8}
            >
              <Text style={[s.inlineFollowText, { color: c }]}>{isFollowing ? '…' : '+ Follow'}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {article.image_url ? <Image source={{ uri: article.image_url }} style={s.heroImage} resizeMode="cover" /> : null}
      <Text style={s.heroTitle} numberOfLines={3}>{article.title}</Text>
      {article.excerpt && stripHtml(article.excerpt).trim().length > 25 ? <Text style={s.heroExcerpt} numberOfLines={2}>{stripHtml(article.excerpt)}</Text> : null}

      <View style={s.heroMeta}>
        {smartAge(article.pub_date) ? <Text style={s.metaChip}>{smartAge(article.pub_date)}</Text> : null}
        {readingTime(article.word_count) ? (
          <View style={s.readChip}>
            <Ionicons name="time-outline" size={11} color={colors.textMuted} />
            <Text style={s.metaChip}>{readingTime(article.word_count)}</Text>
          </View>
        ) : null}
        {progress >= 1 && (
          <View style={[s.readChip, { backgroundColor: colors.success + '15' }]}>
            <Ionicons name="checkmark-circle" size={12} color={colors.success} />
            <Text style={[s.metaChip, { color: colors.success }]}>Read</Text>
          </View>
        )}
      </View>

      {progress > 0 && progress < 1 && (
        <View style={s.progressTrack}>
          <LinearGradient colors={[c, c + 'AA']} style={[s.progressFill, { width: `${progress * 100}%` as any }]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} />
        </View>
      )}
    </TouchableOpacity>
  );
}

const HeroCard = React.memo(HeroCardInner, (prev, next) =>
  prev.article.id === next.article.id &&
  prev.progress === next.progress &&
  prev.isSaved === next.isSaved &&
  prev.isFollowing === next.isFollowing &&
  prev.showFollow === next.showFollow,
);

// ─── ArticleCard ──────────────────────────────────────────────────────────────

function ArticleCardInner({
  article, onPress, onLongPress, showFollow, onFollow, isFollowing, isSaved, progress,
}: {
  article: ArticleRow;
  onPress: () => void;
  onLongPress: () => void;
  showFollow?: boolean;
  onFollow?: () => void;
  isFollowing?: boolean;
  isSaved?: boolean;
  progress: number;
}) {
  const colors = useColors();
  const s = useMemo(() => createFeedStyles(colors), [colors]);
  const pub = PUBLICATIONS.find((p) => p.id === article.publication_id);
  const remoteMeta = pub ? null : getRemoteMetaSync(article.publication_id);
  const c = pub?.color ?? remoteMeta?.color ?? colors.accent;
  const pubName = pub?.name ?? remoteMeta?.name ?? 'Source';
  const feedUrl = article.link;

  return (
    <TouchableOpacity style={s.card} onPress={onPress} onLongPress={onLongPress} activeOpacity={0.8} delayLongPress={380}>
      <View style={[s.cardStrip, { backgroundColor: c }]} />
      <View style={s.cardBody}>
        <View style={s.cardTop}>
          <View style={s.cardPubRow}>
            <FaviconIcon feedUrl={feedUrl} emoji={pub?.emoji ?? '📰'} size={16} />
            <Text style={[s.cardPub, { color: c }]}>{pubName}</Text>
          </View>
          <View style={s.cardTopRight}>
            {smartAge(article.pub_date) ? <Text style={s.cardAge}>{smartAge(article.pub_date)}</Text> : null}
            {isSaved && <Ionicons name="bookmark" size={14} color={colors.accent} />}
            {showFollow && (
              <TouchableOpacity
                onPress={onFollow}
                style={[s.inlineFollowBtn, { borderColor: c + '66', backgroundColor: c + '18' }]}
                disabled={isFollowing}
                hitSlop={8}
              >
                <Text style={[s.inlineFollowText, { color: c }]}>{isFollowing ? '…' : '+ Follow'}</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
        <View style={s.cardRow}>
          <Text style={[s.cardTitle, article.image_url ? { flex: 1 } : {}]} numberOfLines={3}>{article.title}</Text>
          {article.image_url ? <Image source={{ uri: article.image_url }} style={s.cardThumb} resizeMode="cover" /> : null}
        </View>
        {article.excerpt && stripHtml(article.excerpt).trim().length > 25 ? (
          <Text style={s.cardExcerpt} numberOfLines={2}>{stripHtml(article.excerpt)}</Text>
        ) : null}
        <View style={s.cardBottom}>
          {readingTime(article.word_count) && (
            <View style={s.readChip}>
              <Ionicons name="time-outline" size={11} color={colors.textMuted} />
              <Text style={s.metaChip}>{readingTime(article.word_count)}</Text>
            </View>
          )}
          {progress >= 1 && <Ionicons name="checkmark-circle" size={16} color={colors.success} />}
          {progress > 0 && progress < 1 && (
            <View style={s.miniTrack}>
              <View style={[s.miniFill, { width: `${progress * 100}%` as any, backgroundColor: c }]} />
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

const ArticleCard = React.memo(ArticleCardInner, (prev, next) =>
  prev.article.id === next.article.id &&
  prev.progress === next.progress &&
  prev.isSaved === next.isSaved &&
  prev.isFollowing === next.isFollowing &&
  prev.showFollow === next.showFollow,
);

// ─── ActionSheet ──────────────────────────────────────────────────────────────

interface SheetState {
  article: ArticleRow | null;
  isSaved: boolean;
  isFollowed: boolean;
  isCompleted: boolean;
  pubName: string;
  pubColor: string;
}

function ActionSheet({
  sheet, mounted, animY, animBg, onClose, onAction,
}: {
  sheet: SheetState;
  mounted: boolean;
  animY: Animated.Value;
  animBg: Animated.Value;
  onClose: () => void;
  onAction: (action: string) => void;
}) {
  const colors = useColors();
  const s = useMemo(() => createFeedStyles(colors), [colors]);
  if (!mounted) return null;

  const rows = [
    {
      icon: sheet.isSaved ? 'bookmark' : 'bookmark-outline' as any,
      label: sheet.isSaved ? 'Remove from Library' : 'Save to Library',
      color: colors.accent,
      action: 'save',
    },
    {
      icon: sheet.isCompleted ? 'bookmark-outline' : 'checkmark-circle-outline' as any,
      label: sheet.isCompleted ? 'Mark as unread' : 'Mark as read',
      color: colors.accent,
      action: 'toggleRead',
    },
    { icon: 'share-outline' as any, label: 'Share article', color: colors.accent, action: 'share' },
    { icon: 'globe-outline' as any, label: 'Open in browser', color: colors.accent, action: 'browser' },
    {
      icon: sheet.isFollowed ? 'person-remove-outline' : 'person-add-outline' as any,
      label: sheet.isFollowed ? `Unfollow ${sheet.pubName}` : `Follow ${sheet.pubName}`,
      color: sheet.isFollowed ? colors.danger : colors.success,
      action: 'follow',
    },
  ];

  return (
    <Modal transparent animationType="none" visible={mounted} onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: animBg }]}>
        <TouchableOpacity style={[StyleSheet.absoluteFill, s.sheetBackdrop]} onPress={onClose} activeOpacity={1} />
      </Animated.View>
      <Animated.View style={[s.sheet, { transform: [{ translateY: animY }] }]}>
        <View style={s.sheetHandle} />
        <View style={[s.sheetPubBadge, { backgroundColor: sheet.pubColor + '22', borderColor: sheet.pubColor + '44' }]}>
          <Text style={[s.sheetPubName, { color: sheet.pubColor }]}>{sheet.pubName}</Text>
        </View>
        <Text style={s.sheetTitle} numberOfLines={3}>{sheet.article?.title}</Text>
        <View style={s.sheetDivider} />
        {rows.map((row) => (
          <TouchableOpacity key={row.action} style={s.sheetRow} onPress={() => onAction(row.action)} activeOpacity={0.7}>
            <View style={[s.sheetRowIcon, { backgroundColor: row.color + '18' }]}>
              <Ionicons name={row.icon} size={20} color={row.color} />
            </View>
            <Text style={s.sheetRowLabel}>{row.label}</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        ))}
        <View style={{ height: 24 }} />
      </Animated.View>
    </Modal>
  );
}

// ─── FeedScreen ───────────────────────────────────────────────────────────────

export default function FeedScreen() {
  const colors = useColors();
  const s = useMemo(() => createFeedStyles(colors), [colors]);
  const nav = useNavigation<Nav>();
  const flatListRef = useRef<FlatList>(null);

  // Following tab state
  const [allArticles, setAllArticles] = useState<ArticleRow[]>([]);
  const [displayed, setDisplayed] = useState<ArticleRow[]>([]);
  const [followedIds, setFollowedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());

  // Scroll-to-top
  const [showScrollTop, setShowScrollTop] = useState(false);

  // Explore tab state
  const [feedTab, setFeedTab] = useState<'following' | 'explore'>('following');
  const [exploreArticles, setExploreArticles] = useState<ArticleRow[]>([]);
  const [exploreLoading, setExploreLoading] = useState(false);
  const [exploreFollowedSet, setExploreFollowedSet] = useState<Set<string>>(new Set());
  const [followingPubId, setFollowingPubId] = useState<Set<string>>(new Set());
  const tabAnim = useRef(new Animated.Value(0)).current;

  // Remote source metadata (for filter chips)
  const [remoteMetaMap, setRemoteMetaMap] = useState<Map<string, { name: string; color: string; feedUrl: string }>>(new Map());

  // Pagination: nextUrl per pubId, and which pubs are currently fetching a next page
  const [nextUrlMap, setNextUrlMap] = useState<Map<string, string>>(new Map());
  const [loadingMoreIds, setLoadingMoreIds] = useState<Set<string>>(new Set());

  // Fallback: blog URLs for pubs with no RSS pagination — scraped lazily on first end-of-feed
  const [scrapeUrlMap, setScrapeUrlMap] = useState<Map<string, string>>(new Map());

  // Progress for all displayed articles — refreshed as one batch query when displayed changes
  const [progressMap, setProgressMap] = useState<Map<string, number>>(new Map());

  // Hidden articles — ref keeps applyFilter stable (no stale closure on refresh)
  const hiddenRef = useRef<Set<string>>(new Set());
  const [hidden, setHiddenRaw] = useState<Set<string>>(new Set());
  function setHidden(s: Set<string>) { hiddenRef.current = s; setHiddenRaw(s); }

  // Muted publications — unlike hidden articles, this persists (survives refresh/restart)
  // and follows the same stable-ref pattern so applyFilter doesn't need it in its deps.
  const mutedRef = useRef<Set<string>>(new Set());
  const [muted, setMutedRaw] = useState<Set<string>>(new Set());
  function setMuted(s: Set<string>) { mutedRef.current = s; setMutedRaw(s); }

  // Shuffle — ref keeps loadArticles (stable callback) in sync without adding to its deps
  const [shuffled, setShuffled] = useState(false);
  const shuffledRef = useRef(false);
  // Tracks whether the first load has completed so focus-return calls don't re-randomize
  const hasLoadedRef = useRef(false);

  // Tracks all seen article IDs so background refresh can diff for new posts
  const knownIdsRef = useRef<Set<string>>(new Set());

  // Hide-read toggle
  const [hideRead, setHideRead] = useState(false);

  // Background refresh: pending new articles + pill count
  const [newPostCount, setNewPostCount] = useState(0);
  const [pendingNewArticles, setPendingNewArticles] = useState<ArticleRow[]>([]);
  const bgRefreshRef = useRef<() => Promise<void>>(async () => {});

  // Action sheet — animations live here so they survive open/close cycles
  const sheetAnimY = useRef(new Animated.Value(500)).current;
  const sheetAnimBg = useRef(new Animated.Value(0)).current;
  const [sheetMounted, setSheetMounted] = useState(false);
  const [sheetData, setSheetData] = useState<SheetState>({
    article: null, isSaved: false, isFollowed: false, isCompleted: false, pubName: '', pubColor: colors.accent,
  });

  // Publication action sheet (long-press on filter chip)
  const pubSheetAnimY = useRef(new Animated.Value(500)).current;
  const pubSheetAnimBg = useRef(new Animated.Value(0)).current;
  const [pubSheetMounted, setPubSheetMounted] = useState(false);
  const [pubSheetData, setPubSheetData] = useState<{ id: string; name: string; color: string } | null>(null);

  // Searchable publication filter list — the horizontal chip row doesn't scale once
  // someone follows a lot of sources, so this is the "find one by typing" alternative.
  const pubSearchAnimY = useRef(new Animated.Value(PUB_SEARCH_H)).current;
  const pubSearchAnimBg = useRef(new Animated.Value(0)).current;
  const [pubSearchMounted, setPubSearchMounted] = useState(false);
  const [pubSearchQuery, setPubSearchQuery] = useState('');

  // ── Data loading ────────────────────────────────────────────────────────────

  const applyFilter = useCallback((articles: ArticleRow[], filter: string | null, isShuffle = false) => {
    const base = filter ? articles.filter((a) => a.publication_id === filter) : articles;
    const seed = dailySeed();
    const ordered = isShuffle
      ? seededShuffle(base, seed)
      : interleave(base, seed);
    setDisplayed(ordered.filter((a) => !hiddenRef.current.has(a.id) && !mutedRef.current.has(a.publication_id)));
  // hiddenRef/mutedRef are mutable refs — intentionally not in deps so applyFilter stays stable
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleShuffle() {
    const next = !shuffled;
    setShuffled(next);
    shuffledRef.current = next;
    applyFilter(allArticles, activeFilter, next);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }

  function toggleHideRead() {
    setHideRead((prev) => !prev);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }

  function acceptNewPosts() {
    const newArticles = pendingNewArticles;
    const toAdd = newArticles.filter(
      (a) => !hiddenRef.current.has(a.id) && !mutedRef.current.has(a.publication_id) &&
        (!activeFilter || activeFilter === a.publication_id),
    );
    setAllArticles((prev) => {
      const existing = new Set(prev.map((a) => a.id));
      const fresh = newArticles.filter((a) => !existing.has(a.id));
      return fresh.length ? [...fresh, ...prev] : prev;
    });
    setDisplayed((prev) => {
      const existing = new Set(prev.map((a) => a.id));
      const fresh = toAdd.filter((a) => !existing.has(a.id));
      return fresh.length ? [...fresh, ...prev] : prev;
    });
    newArticles.forEach((a) => knownIdsRef.current.add(a.id));
    setPendingNewArticles([]);
    setNewPostCount(0);
    flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }

  const loadArticles = useCallback(async (fromNetwork = false, forceReapply = false) => {
    const ids = await getFollowedIds();
    setFollowedIds(ids);
    setMuted(new Set(await getMutedIds()));
    if (ids.length === 0) { setAllArticles([]); setDisplayed([]); setLoading(false); setRefreshing(false); return; }

    // Always load remote sources to populate filter chips + cache
    const remoteSrcList = await getAllRemoteSources().catch(() => []);
    const rMap = new Map(remoteSrcList.map((r) => [r.id, { name: r.name, color: r.color, feedUrl: r.feed_url }]));
    setRemoteMetaMap(rMap);

    if (fromNetwork) {
      const remoteById = new Map(remoteSrcList.map((r) => [r.id, r]));
      const nextMap = new Map<string, string>();

      // When a single pub is active, only refresh that one; otherwise refresh all
      const idsToFetch = activeFilter ? [activeFilter] : ids;

      await Promise.all(idsToFetch.map(async (pubId) => {
        const pub = PUBLICATIONS.find((p) => p.id === pubId);
        const remote = remoteById.get(pubId);
        const feedUrl = pub?.feedUrl ?? remote?.feed_url;
        if (!feedUrl) return;
        // Use the stored website_url (from Feedly) as the blog scrape target when available,
        // falling back to deriveBlogUrl for curated pubs or pubs followed before v10.
        const blogUrl = remote?.website_url ?? deriveBlogUrl(feedUrl);
        try {
          const { items, nextUrl } = await fetchFeedPage(feedUrl);
          await upsertArticles(items.map((item) => feedItemToRow(item, pubId)));
          let paginationUrl = nextUrl ?? null;

          if (items.length < 25 && !nextUrl && blogUrl) {
            try {
              const { items: scraped, nextUrl: scrapedNext } = await scrapeForArticles(blogUrl);
              if (scraped.length > 0) {
                await upsertArticles(scraped.map((item) => feedItemToRow(item, pubId)));
              }
              if (scrapedNext) paginationUrl = scrapedNext;
            } catch {}
          }

          if (paginationUrl) nextMap.set(pubId, paginationUrl);
        } catch {
          // RSS fetch failed — fall back to scraping the blog page directly
          if (blogUrl) {
            try {
              const { items: scraped, nextUrl: scrapedNext } = await scrapeForArticles(blogUrl);
              if (scraped.length > 0) {
                await upsertArticles(scraped.map((item) => feedItemToRow(item, pubId)));
                if (scrapedNext) nextMap.set(pubId, scrapedNext);
              }
            } catch {}
          }
        }
      }));

      // Merge pagination map: for single-pub refresh keep other pubs' entries intact
      if (activeFilter) {
        setNextUrlMap((prev) => {
          const updated = new Map(prev);
          for (const [k, v] of nextMap) updated.set(k, v);
          if (!nextMap.has(activeFilter)) updated.delete(activeFilter);
          return updated;
        });
      } else {
        setNextUrlMap(nextMap);
      }

      // Derive lazy-scrape URLs for pubs without RSS pagination
      const fMap = new Map<string, string>();
      for (const pubId of ids) {
        if (nextMap.has(pubId)) continue;
        const pub = PUBLICATIONS.find((p) => p.id === pubId);
        const remote = remoteById.get(pubId);
        const feedUrl = pub?.feedUrl ?? remote?.feed_url;
        if (!feedUrl) continue;
        const bUrl = remote?.website_url ?? deriveBlogUrl(feedUrl);
        if (bUrl) fMap.set(pubId, bUrl);
      }
      setScrapeUrlMap(fMap);
    }

    const [rows, saved] = await Promise.all([
      getArticlesForPublications(ids),
      getSavedIds(),
    ]);
    setSavedIds(saved);
    setAllArticles(rows);
    rows.forEach((a) => knownIdsRef.current.add(a.id));
    // First load, pull-to-refresh, or forced reapply (e.g. after unfollow): re-order.
    // Focus-return: keep existing order so shuffle/filter state is preserved.
    if (!hasLoadedRef.current || fromNetwork || forceReapply) {
      applyFilter(rows, activeFilter, shuffledRef.current);
      hasLoadedRef.current = true;
    } else {
      // Just remove any newly-hidden articles or newly-muted publications from the existing ordered list
      setDisplayed((prev) => prev.filter((a) => !hiddenRef.current.has(a.id) && !mutedRef.current.has(a.publication_id)));
    }
    setLoading(false);
    setRefreshing(false);
  }, [activeFilter, applyFilter]);

  useFocusEffect(useCallback(() => {
    void loadArticles(false);
    // When a remote-follow background fetch completes, reload from SQLite immediately
    const sub = DeviceEventEmitter.addListener('feedRefreshNeeded', () => {
      void loadArticles(false);
    });
    return () => sub.remove();
  }, [loadArticles]));

  // Batch-refresh progress whenever the displayed list changes (including focus returns)
  useEffect(() => {
    if (displayed.length === 0) return;
    void getProgressBatch(displayed.map((a) => a.id)).then(setProgressMap);
  }, [displayed]);
  useEffect(() => { void loadArticles(true); }, []);

  // Keep bgRefreshRef in sync with latest state so the stable interval can call it
  useEffect(() => {
    bgRefreshRef.current = async () => {
      if (feedTab !== 'following') return;
      try {
        const ids = await getFollowedIds();
        if (ids.length === 0) return;
        const remoteSrcList = await getAllRemoteSources().catch(() => []);
        const remoteById = new Map(remoteSrcList.map((r) => [r.id, r]));
        await Promise.allSettled(ids.map(async (pubId) => {
          const pub = PUBLICATIONS.find((p) => p.id === pubId);
          const remote = remoteById.get(pubId);
          const feedUrl = pub?.feedUrl ?? (remote as any)?.feed_url;
          if (!feedUrl) return;
          try {
            const { items } = await fetchFeedPage(feedUrl);
            await upsertArticles(items.map((item) => feedItemToRow(item, pubId)));
          } catch {}
        }));
        const fresh = await getArticlesForPublications(ids);
        const newOnes = fresh.filter((a) => !knownIdsRef.current.has(a.id));
        if (newOnes.length > 0) {
          setPendingNewArticles(newOnes);
          setNewPostCount(newOnes.length);
        }
      } catch {}
    };
  }, [feedTab]);

  useEffect(() => {
    const id = setInterval(() => { void bgRefreshRef.current(); }, 10 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const loadExploreArticles = useCallback(async () => {
    if (exploreArticles.length > 0) return;
    setExploreLoading(true);
    try {
      const ids = await getFollowedIds();
      const followed = new Set(ids);
      setExploreFollowedSet(followed);

      const followedPubs = PUBLICATIONS.filter((p) => followed.has(p.id));
      const userTopics = new Set(followedPubs.flatMap((p) => p.topics));
      const suggested = userTopics.size > 0
        ? PUBLICATIONS.filter((p) => !followed.has(p.id) && p.topics.some((t) => userTopics.has(t)))
        : PUBLICATIONS.filter((p) => !followed.has(p.id)).slice(0, 15);

      await Promise.allSettled(
        suggested.slice(0, 6).map(async (pub) => {
          try {
            const items = await fetchFeed(pub.feedUrl);
            await upsertArticles(items.slice(0, 8).map((i) => feedItemToRow(i, pub.id)));
          } catch {}
        }),
      );

      const rows = await getArticlesForPublications(suggested.map((p) => p.id));
      setExploreArticles(interleave(rows).filter((a) => !hidden.has(a.id)));
    } finally {
      setExploreLoading(false);
    }
  }, [exploreArticles.length, hidden]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setHidden(new Set()); // pull-to-refresh restores all hidden articles
    void loadArticles(true);
  }, [loadArticles]);

  async function handleLoadMore(pubId: string) {
    const url = nextUrlMap.get(pubId);
    if (!url || loadingMoreIds.has(pubId)) return;
    setLoadingMoreIds((prev) => new Set(prev).add(pubId));
    try {
      // Try RSS; if empty (URL is a web page, not a feed) fall back to scraping
      let result: { items: FeedItem[]; nextUrl: string | null };
      try {
        result = await fetchFeedPage(url);
        if (result.items.length === 0) throw new Error('empty');
      } catch {
        result = await scrapeForArticles(url);
      }
      const { items, nextUrl } = result;

      await upsertArticles(items.map((item) => feedItemToRow(item, pubId)));

      // Update pagination pointer (advance or remove)
      setNextUrlMap((prev) => {
        const m = new Map(prev);
        if (nextUrl) m.set(pubId, nextUrl);
        else m.delete(pubId);
        return m;
      });

      // Re-query SQLite for this pub — authoritative, picks up whatever was just upserted
      const freshRows = await getArticlesForPublications([pubId]);
      setAllArticles((prev) => {
        const existing = new Set(prev.map((a) => a.id));
        const added = freshRows.filter((a) => !existing.has(a.id));
        return added.length ? [...prev, ...added] : prev;
      });
      setDisplayed((prev) => {
        const existing = new Set(prev.map((a) => a.id));
        const toAdd = freshRows.filter(
          (a) => !existing.has(a.id) && !hidden.has(a.id) && !mutedRef.current.has(a.publication_id) &&
            (!activeFilter || activeFilter === pubId),
        );
        return toAdd.length ? [...prev, ...toAdd] : prev;
      });
    } catch {}
    setLoadingMoreIds((prev) => { const s = new Set(prev); s.delete(pubId); return s; });
  }

  async function handleScrapeLoad(pubId: string) {
    const blogUrl = scrapeUrlMap.get(pubId);
    if (!blogUrl || loadingMoreIds.has(pubId)) return;
    // Remove immediately so repeated end-of-feed events don't retry the same scrape
    setScrapeUrlMap((prev) => { const m = new Map(prev); m.delete(pubId); return m; });
    setLoadingMoreIds((prev) => new Set(prev).add(pubId));
    try {
      const { items, nextUrl } = await scrapeForArticles(blogUrl);
      if (items.length > 0) {
        await upsertArticles(items.map((item) => feedItemToRow(item, pubId)));
        const freshRows = await getArticlesForPublications([pubId]);
        setAllArticles((prev) => {
          const existing = new Set(prev.map((a) => a.id));
          const added = freshRows.filter((a) => !existing.has(a.id));
          return added.length ? [...prev, ...added] : prev;
        });
        setDisplayed((prev) => {
          const existing = new Set(prev.map((a) => a.id));
          const toAdd = freshRows.filter(
            (a) => !existing.has(a.id) && !hiddenRef.current.has(a.id) && !mutedRef.current.has(a.publication_id) &&
              (!activeFilter || activeFilter === pubId),
          );
          return toAdd.length ? [...prev, ...toAdd] : prev;
        });
      }
      // If scraping found pagination, wire it up for further scroll-loads
      if (nextUrl) setNextUrlMap((prev) => new Map(prev).set(pubId, nextUrl));
    } catch {}
    setLoadingMoreIds((prev) => { const s = new Set(prev); s.delete(pubId); return s; });
  }

  function handleAutoLoadMore() {
    if (feedTab !== 'following') return;
    // RSS-paginated pubs — skip muted ones entirely, no point paginating content
    // that's just going to be filtered back out of the displayed feed
    const rssIds = [...nextUrlMap.keys()].filter(
      (pubId) => !mutedRef.current.has(pubId) && (!activeFilter || activeFilter === pubId),
    );
    rssIds.forEach((pubId) => void handleLoadMore(pubId));
    // Unpaginated pubs — try scraping their blog page once per session
    const scrapeIds = [...scrapeUrlMap.keys()].filter(
      (pubId) => !mutedRef.current.has(pubId) && (!activeFilter || activeFilter === pubId),
    );
    scrapeIds.forEach((pubId) => void handleScrapeLoad(pubId));
  }

  function selectFilter(id: string | null) {
    setShuffled(false);
    shuffledRef.current = false;
    setActiveFilter(id);
    applyFilter(allArticles, id, false);
  }

  function switchTab(tab: 'following' | 'explore') {
    setFeedTab(tab);
    Animated.spring(tabAnim, { toValue: tab === 'following' ? 0 : 1, useNativeDriver: true, tension: 100, friction: 14 }).start();
    if (tab === 'explore') void loadExploreArticles();
  }

  function openArticle(a: ArticleRow) {
    nav.navigate('Reader', { articleId: a.id, publicationId: a.publication_id });
  }

  // ── Scroll-to-top ──────────────────────────────────────────────────────────

  function handleScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const y = e.nativeEvent.contentOffset.y;
    setShowScrollTop(y > SCROLL_TOP_THRESHOLD);
  }

  function scrollToTop() {
    flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }

  // ── Auto-pagination on scroll end ──────────────────────────────────────────

  function handleAutoLoadMore() {
    if (feedTab !== 'following') return;
    // RSS-paginated pubs — skip muted ones entirely, no point paginating content
    // that's just going to be filtered back out of the displayed feed
    const rssIds = [...nextUrlMap.keys()].filter(
      (pubId) => !mutedRef.current.has(pubId) && (!activeFilter || activeFilter === pubId),
    );
    rssIds.forEach((pubId) => void handleLoadMore(pubId));
    // Unpaginated pubs — try scraping their blog page once per session
    const scrapeIds = [...scrapeUrlMap.keys()].filter(
      (pubId) => !mutedRef.current.has(pubId) && (!activeFilter || activeFilter === pubId),
    );
    scrapeIds.forEach((pubId) => void handleScrapeLoad(pubId));
  }

  // ── Swipe actions ──────────────────────────────────────────────────────────

  async function handleSave(article: ArticleRow) {
    const alreadySaved = savedIds.has(article.id);
    if (alreadySaved) {
      await unsaveArticle(article.id);
      setSavedIds((prev) => { const s = new Set(prev); s.delete(article.id); return s; });
    } else {
      await saveArticle(article.id);
      setSavedIds((prev) => new Set(prev).add(article.id));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  }

  function handleHide(article: ArticleRow) {
    AppAlert.alert(
      'Hide article?',
      `"${article.title}"\n\nIt won't appear in your feed. Pull down to refresh to restore it.`,
      [
        { text: 'Keep', style: 'cancel' },
        { text: 'Hide', onPress: () => confirmHide(article) },
      ],
    );
  }

  function confirmHide(article: ArticleRow) {
    const next = new Set(hiddenRef.current).add(article.id);
    setHidden(next);
    if (feedTab === 'following') {
      setDisplayed((prev) => prev.filter((a) => a.id !== article.id));
    } else {
      setExploreArticles((prev) => prev.filter((a) => a.id !== article.id));
    }
  }

  // ── Explore follow ─────────────────────────────────────────────────────────

  async function handleExploreFollow(pubId: string) {
    if (exploreFollowedSet.has(pubId) || followingPubId.has(pubId)) return;
    setFollowingPubId((prev) => new Set(prev).add(pubId));
    try {
      await followPublication(pubId);
      setExploreFollowedSet((prev) => new Set(prev).add(pubId));
      const pub = PUBLICATIONS.find((p) => p.id === pubId);
      if (pub) {
        fetchFeed(pub.feedUrl)
          .then((items) => upsertArticles(items.slice(0, 20).map((i) => feedItemToRow(i, pubId))))
          .catch(() => {});
      }
    } finally {
      setFollowingPubId((prev) => { const s = new Set(prev); s.delete(pubId); return s; });
    }
  }

  // ── Action sheet ───────────────────────────────────────────────────────────

  async function openSheet(article: ArticleRow) {
    const pub = PUBLICATIONS.find((p) => p.id === article.publication_id);
    const remoteMeta = pub ? null : getRemoteMetaSync(article.publication_id);
    const [saved, ids] = await Promise.all([isArticleSaved(article.id), getFollowedIds()]);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSheetData({
      article,
      isSaved: saved,
      isFollowed: ids.includes(article.publication_id),
      isCompleted: (progressMap.get(article.id) ?? 0) >= 1,
      pubName: pub?.name ?? remoteMeta?.name ?? 'Source',
      pubColor: pub?.color ?? remoteMeta?.color ?? colors.accent,
    });
    // Reset to off-screen, mount, then animate in
    sheetAnimY.setValue(500);
    sheetAnimBg.setValue(0);
    setSheetMounted(true);
    Animated.parallel([
      Animated.spring(sheetAnimY, { toValue: 0, useNativeDriver: true, tension: 80, friction: 13 }),
      Animated.timing(sheetAnimBg, { toValue: 1, duration: 220, useNativeDriver: true }),
    ]).start();
  }

  function closeSheet() {
    Animated.parallel([
      Animated.timing(sheetAnimY, { toValue: 500, duration: 260, useNativeDriver: true }),
      Animated.timing(sheetAnimBg, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start(() => setSheetMounted(false));
  }

  function openPubSheet(pub: { id: string; name: string; color: string }) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setPubSheetData(pub);
    pubSheetAnimY.setValue(500);
    pubSheetAnimBg.setValue(0);
    setPubSheetMounted(true);
    Animated.parallel([
      Animated.spring(pubSheetAnimY, { toValue: 0, useNativeDriver: true, tension: 80, friction: 13 }),
      Animated.timing(pubSheetAnimBg, { toValue: 1, duration: 220, useNativeDriver: true }),
    ]).start();
  }

  function closePubSheet() {
    Animated.parallel([
      Animated.timing(pubSheetAnimY, { toValue: 500, duration: 260, useNativeDriver: true }),
      Animated.timing(pubSheetAnimBg, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start(() => setPubSheetMounted(false));
  }

  function openPubSearch() {
    setPubSearchQuery('');
    pubSearchAnimY.setValue(PUB_SEARCH_H);
    pubSearchAnimBg.setValue(0);
    setPubSearchMounted(true);
    Animated.parallel([
      Animated.spring(pubSearchAnimY, { toValue: 0, useNativeDriver: true, tension: 80, friction: 13 }),
      Animated.timing(pubSearchAnimBg, { toValue: 1, duration: 220, useNativeDriver: true }),
    ]).start();
  }

  function closePubSearch() {
    Animated.parallel([
      Animated.timing(pubSearchAnimY, { toValue: PUB_SEARCH_H, duration: 260, useNativeDriver: true }),
      Animated.timing(pubSearchAnimBg, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start(() => setPubSearchMounted(false));
  }

  function selectFilterFromSearch(id: string | null) {
    selectFilter(id);
    closePubSearch();
  }

  async function handleUnfollowPub() {
    if (!pubSheetData) return;
    const { id } = pubSheetData;
    closePubSheet();
    if (activeFilter === id) setActiveFilter(null);
    await unfollowPublication(id);
    void loadArticles(false, true);
  }

  async function handleToggleMutePub() {
    if (!pubSheetData) return;
    const { id } = pubSheetData;
    closePubSheet();
    if (mutedRef.current.has(id)) {
      await unmutePublication(id);
      const next = new Set(mutedRef.current); next.delete(id);
      setMuted(next);
    } else {
      await mutePublication(id);
      setMuted(new Set(mutedRef.current).add(id));
    }
    void loadArticles(false, true);
  }

  async function handleSheetAction(action: string) {
    const article = sheetData.article;
    if (!article) return;
    closeSheet();
    switch (action) {
      case 'save':
        if (sheetData.isSaved) {
          await unsaveArticle(article.id);
          setSavedIds((prev) => { const s = new Set(prev); s.delete(article.id); return s; });
        } else {
          await saveArticle(article.id);
          setSavedIds((prev) => new Set(prev).add(article.id));
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
        break;
      case 'toggleRead': {
        const nextCompleted = !sheetData.isCompleted;
        await toggleArticleRead(article.id, nextCompleted);
        setProgressMap((prev) => {
          const next = new Map(prev);
          next.set(article.id, nextCompleted ? 1 : 0);
          return next;
        });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        break;
      }
      case 'share':
        await Share.share({ message: `${article.title}\n${article.link}` });
        break;
      case 'browser':
        await Linking.openURL(article.link);
        break;
      case 'follow':
        if (sheetData.isFollowed) {
          await unfollowPublication(article.publication_id);
          void loadArticles(false, true);
        } else {
          await followPublication(article.publication_id);
          const pub = PUBLICATIONS.find((p) => p.id === article.publication_id);
          if (pub) {
            fetchFeed(pub.feedUrl)
              .then((items) => upsertArticles(items.slice(0, 20).map((i) => feedItemToRow(i, pub.id))))
              .catch(() => {});
          }
        }
        break;
    }
  }

  // ── Render helpers ─────────────────────────────────────────────────────────

  const tabIndicatorX = tabAnim.interpolate({ inputRange: [0, 1], outputRange: [0, HALF_W] });

  const inProgressArticles = useMemo(() =>
    allArticles.filter((a) => {
      const p = progressMap.get(a.id) ?? 0;
      return p > 0.02 && p < 1;
    }).slice(0, 8),
  [allArticles, progressMap]);

  const visibleArticles = useMemo(() => {
    if (!hideRead) return displayed;
    return displayed.filter((a) => (progressMap.get(a.id) ?? 0) < 1);
  }, [displayed, hideRead, progressMap]);

  const renderItem = useCallback(({ item, index }: { item: ArticleRow; index: number }) => {
    const isExplore = feedTab === 'explore';
    const pubIsFollowed = isExplore
      ? exploreFollowedSet.has(item.publication_id)
      : followedIds.includes(item.publication_id);
    const isPending = followingPubId.has(item.publication_id);
    const sharedProps = {
      article: item,
      onPress: () => openArticle(item),
      onLongPress: () => void openSheet(item),
      showFollow: isExplore && !pubIsFollowed,
      onFollow: () => void handleExploreFollow(item.publication_id),
      isFollowing: isPending,
      isSaved: savedIds.has(item.id),
      progress: progressMap.get(item.id) ?? 0,
    };

    return (
      <SwipeableCard
        onSwipeRight={() => void handleSave(item)}
        onSwipeLeft={() => handleHide(item)}
        isSaved={savedIds.has(item.id)}
      >
        {index === 0
          ? <HeroCard {...sharedProps} />
          : <ArticleCard {...sharedProps} />
        }
      </SwipeableCard>
    );
  }, [feedTab, exploreFollowedSet, followedIds, followingPubId, savedIds, progressMap, hidden]);

  // ── Early returns ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={[s.root, s.centered]}>
        <StatusBar barStyle="light-content" backgroundColor={colors.bgDeep} />
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  // Build filter chip list from both static pubs and remote sources
  const followedPubs = followedIds.map((id) => {
    const pub = PUBLICATIONS.find((p) => p.id === id);
    if (pub) return { id: pub.id, name: pub.name, emoji: pub.emoji, color: pub.color, feedUrl: pub.feedUrl };
    const rm = remoteMetaMap.get(id);
    if (rm) return { id, name: rm.name, emoji: '📰' as string, color: rm.color, feedUrl: rm.feedUrl };
    return null;
  }).filter(Boolean) as Array<{ id: string; name: string; emoji: string; color: string; feedUrl: string }>;
  const activeData = feedTab === 'following' ? visibleArticles : exploreArticles;
  const pubSearchResults = pubSearchQuery.trim()
    ? followedPubs.filter((p) => p.name.toLowerCase().includes(pubSearchQuery.trim().toLowerCase()))
    : followedPubs;

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bgDeep} />
      <LinearGradient colors={[colors.bgDeep, colors.bg]} style={StyleSheet.absoluteFill} />

      <SafeAreaView edges={['top']} style={{ flex: 1 }}>
        {/* ── Header ── */}
        <View style={s.header}>
          <View>
            <Text style={s.headerDate}>{format(new Date(), 'EEEE, MMMM d').toUpperCase()}</Text>
            <Text style={s.headerTitle}>{feedTab === 'following' ? 'Your Feed' : 'For You'}</Text>
          </View>
          <View style={s.headerRight}>
            {feedTab === 'following' && (
              <>
                <TouchableOpacity
                  onPress={toggleHideRead}
                  style={[s.shuffleBtn, hideRead && s.shuffleBtnActive]}
                  hitSlop={8}
                >
                  <Ionicons name={hideRead ? 'eye-off' : 'eye-outline'} size={18} color={hideRead ? colors.accent : colors.textMuted} />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={toggleShuffle}
                  style={[s.shuffleBtn, shuffled && s.shuffleBtnActive]}
                  hitSlop={8}
                >
                  <Ionicons name="shuffle" size={18} color={shuffled ? colors.accent : colors.textMuted} />
                </TouchableOpacity>
              </>
            )}
            <View style={s.countBadge}>
              <Text style={s.countText}>{activeData.length}</Text>
            </View>
          </View>
        </View>

        {/* ── Tab switcher ── */}
        <View style={s.tabBar}>
          <TouchableOpacity style={s.tabBtn} onPress={() => switchTab('following')} activeOpacity={0.7}>
            <Text style={[s.tabLabel, feedTab === 'following' && s.tabLabelActive]}>Following</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.tabBtn} onPress={() => switchTab('explore')} activeOpacity={0.7}>
            <Text style={[s.tabLabel, feedTab === 'explore' && s.tabLabelActive]}>Explore</Text>
          </TouchableOpacity>
          {/* Bottom border sits behind the indicator */}
          <View style={s.tabBorderLine} />
          <Animated.View style={[s.tabIndicator, { transform: [{ translateX: tabIndicatorX }] }]} />
        </View>

        {/* ── Publication filter chips (Following only) ── */}
        {feedTab === 'following' && followedIds.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={s.filterScroll}
            contentContainerStyle={s.filterRow}
          >
            {followedPubs.length > 1 && (
              <TouchableOpacity style={s.filterChip} onPress={openPubSearch}>
                <Ionicons name="search-outline" size={14} color={colors.textMuted} />
                <Text style={s.filterChipText}>Search</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={[s.filterChip, !activeFilter && s.filterChipActive]} onPress={() => selectFilter(null)}>
              <Text style={[s.filterChipText, !activeFilter && s.filterChipTextActive]}>All</Text>
            </TouchableOpacity>
            {followedPubs.slice(0, CHIP_ROW_CAP).map((pub) => {
              const active = activeFilter === pub.id;
              const isMuted = muted.has(pub.id);
              return (
                <TouchableOpacity
                  key={pub.id}
                  style={[s.filterChip, active && { backgroundColor: pub.color + '1A', borderColor: pub.color + '60' }]}
                  onPress={() => selectFilter(active ? null : pub.id)}
                  onLongPress={() => openPubSheet({ id: pub.id, name: pub.name, color: pub.color })}
                  delayLongPress={350}
                >
                  {isMuted
                    ? <Ionicons name="volume-mute-outline" size={14} color={colors.textMuted} />
                    : <FaviconIcon feedUrl={pub.feedUrl} emoji={pub.emoji} size={16} />
                  }
                  <Text style={[s.filterChipText, active && { color: pub.color }, isMuted && { color: colors.textMuted }]}>
                    {pub.name}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}

        {/* ── Content ── */}
        {feedTab === 'explore' && exploreLoading ? (
          <View style={s.centered}>
            <ActivityIndicator color={colors.accent} size="large" />
            <Text style={s.loadingText}>Finding articles for you…</Text>
          </View>
        ) : feedTab === 'following' && followedIds.length === 0 ? (
          <View style={s.centered}>
            <Ionicons name="book-outline" size={56} color={colors.textMuted} />
            <Text style={s.emptyTitle}>Nothing here yet</Text>
            <Text style={s.emptySub}>Go to Discover and follow some publications</Text>
            <TouchableOpacity
              style={s.emptyCta}
              onPress={() => nav.navigate('Tabs', { screen: 'Discover' })}
              activeOpacity={0.85}
            >
              <Ionicons name="compass-outline" size={16} color={colors.bgDeep} />
              <Text style={s.emptyCtaText}>Go to Discover</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={{ flex: 1 }}>
            {newPostCount > 0 && feedTab === 'following' && (
              <View style={s.newPostsPillRow} pointerEvents="box-none">
                <TouchableOpacity style={s.newPostsPill} onPress={acceptNewPosts} activeOpacity={0.85}>
                  <Ionicons name="arrow-up" size={14} color={colors.bg} />
                  <Text style={s.newPostsPillText}>{newPostCount} new post{newPostCount !== 1 ? 's' : ''}</Text>
                </TouchableOpacity>
              </View>
            )}
          <FlatList
            ref={flatListRef}
            data={activeData}
            keyExtractor={(a) => a.id}
            contentContainerStyle={s.list}
            showsVerticalScrollIndicator={false}
            onScroll={handleScroll}
            scrollEventThrottle={16}
            removeClippedSubviews
            maxToRenderPerBatch={8}
            updateCellsBatchingPeriod={50}
            windowSize={10}
            initialNumToRender={10}
            onEndReached={handleAutoLoadMore}
            onEndReachedThreshold={0.4}
            ListHeaderComponent={feedTab === 'following' && inProgressArticles.length > 0 ? (
              <View style={s.continueStrip}>
                <Text style={s.continueTitle}>Continue reading</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.continueRow}>
                  {inProgressArticles.map((a) => {
                    const pub = PUBLICATIONS.find((p) => p.id === a.publication_id);
                    const rm = pub ? null : getRemoteMetaSync(a.publication_id);
                    const c = pub?.color ?? rm?.color ?? colors.accent;
                    const pubName = pub?.name ?? rm?.name ?? 'Source';
                    const prog = progressMap.get(a.id) ?? 0;
                    return (
                      <TouchableOpacity key={a.id} style={s.continueCard} onPress={() => openArticle(a)} activeOpacity={0.8}>
                        <View style={s.continueCardBody}>
                          <View style={s.continuePubRow}>
                            <FaviconIcon feedUrl={a.link} emoji={pub?.emoji ?? '📰'} size={12} />
                            <Text style={[s.continuePubName, { color: c }]} numberOfLines={1}>{pubName}</Text>
                          </View>
                          <Text style={s.continueCardTitle} numberOfLines={2}>{stripCdata(a.title)}</Text>
                        </View>
                        <View style={s.continueProgressTrack}>
                          <View style={[s.continueProgressFill, { width: `${Math.round(prog * 100)}%` as any, backgroundColor: c }]} />
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>
            ) : null}
            refreshControl={
              feedTab === 'following'
                ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
                : undefined
            }
            renderItem={renderItem}
            ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
            ListFooterComponent={(() => {
              if (feedTab !== 'following') return null;
              if (loadingMoreIds.size === 0) return null;
              return (
                <View style={s.loadMoreSection}>
                  <ActivityIndicator color={colors.accent} />
                </View>
              );
            })()}
            ListEmptyComponent={
              <View style={s.centered}>
                <Ionicons name="newspaper-outline" size={48} color={colors.textMuted} />
                <Text style={s.emptyTitle}>No articles yet</Text>
                <Text style={s.emptySub}>Pull to refresh or check back soon</Text>
              </View>
            }
          />
          </View>
        )}
      </SafeAreaView>

      {/* ── Scroll to top FAB ── */}
      {showScrollTop && (
        <TouchableOpacity style={s.scrollTopBtn} onPress={scrollToTop} activeOpacity={0.85}>
          <Ionicons name="arrow-up" size={20} color={colors.bg} />
        </TouchableOpacity>
      )}

      {/* ── Action sheet ── */}
      <ActionSheet
        sheet={sheetData}
        mounted={sheetMounted}
        animY={sheetAnimY}
        animBg={sheetAnimBg}
        onClose={closeSheet}
        onAction={handleSheetAction}
      />

      {/* ── Publication sheet (long-press filter chip) ── */}
      {pubSheetMounted && pubSheetData && (
        <Modal transparent animationType="none" visible={pubSheetMounted} onRequestClose={closePubSheet} statusBarTranslucent>
          <Animated.View style={[StyleSheet.absoluteFill, { opacity: pubSheetAnimBg }]}>
            <TouchableOpacity style={[StyleSheet.absoluteFill, s.sheetBackdrop]} onPress={closePubSheet} activeOpacity={1} />
          </Animated.View>
          <Animated.View style={[s.sheet, { transform: [{ translateY: pubSheetAnimY }] }]}>
            <View style={s.sheetHandle} />
            <View style={[s.sheetPubBadge, { backgroundColor: pubSheetData.color + '22', borderColor: pubSheetData.color + '44' }]}>
              <Text style={[s.sheetPubName, { color: pubSheetData.color }]}>{pubSheetData.name}</Text>
            </View>
            <View style={s.sheetDivider} />
            <TouchableOpacity style={s.sheetRow} onPress={() => void handleToggleMutePub()} activeOpacity={0.7}>
              <View style={[s.sheetRowIcon, { backgroundColor: colors.textMuted + '18' }]}>
                <Ionicons
                  name={muted.has(pubSheetData.id) ? 'volume-high-outline' : 'volume-mute-outline'}
                  size={20}
                  color={colors.textSecondary}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.sheetRowLabel}>
                  {muted.has(pubSheetData.id) ? `Unmute ${pubSheetData.name}` : `Mute ${pubSheetData.name}`}
                </Text>
                <Text style={s.sheetRowDesc}>
                  {muted.has(pubSheetData.id)
                    ? 'Articles will show in your feed again.'
                    : 'Stays followed — just won\'t show articles in your feed.'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </TouchableOpacity>
            <TouchableOpacity style={s.sheetRow} onPress={() => void handleUnfollowPub()} activeOpacity={0.7}>
              <View style={[s.sheetRowIcon, { backgroundColor: colors.danger + '18' }]}>
                <Ionicons name="person-remove-outline" size={20} color={colors.danger} />
              </View>
              <Text style={[s.sheetRowLabel, { color: colors.danger }]}>Unfollow {pubSheetData.name}</Text>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </TouchableOpacity>
            <View style={{ height: 24 }} />
          </Animated.View>
        </Modal>
      )}

      {/* ── Searchable publication filter list ── */}
      {pubSearchMounted && (
        <Modal transparent animationType="none" visible={pubSearchMounted} onRequestClose={closePubSearch} statusBarTranslucent>
          <Animated.View style={[StyleSheet.absoluteFill, { opacity: pubSearchAnimBg }]}>
            <TouchableOpacity style={[StyleSheet.absoluteFill, s.sheetBackdrop]} onPress={closePubSearch} activeOpacity={1} />
          </Animated.View>
          <Animated.View style={[s.sheet, { height: PUB_SEARCH_H, transform: [{ translateY: pubSearchAnimY }] }]}>
            <View style={s.sheetHandle} />
            <View style={s.pubSearchHeader}>
              <Text style={s.sheetTitle}>Filter by source</Text>
              <TouchableOpacity onPress={closePubSearch} hitSlop={10}>
                <Ionicons name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <View style={s.pubSearchInputWrap}>
              <Ionicons name="search-outline" size={16} color={colors.textMuted} />
              <TextInput
                value={pubSearchQuery}
                onChangeText={setPubSearchQuery}
                placeholder="Search followed sources"
                placeholderTextColor={colors.textMuted}
                style={s.pubSearchInput}
                autoCorrect={false}
                autoFocus
              />
              {pubSearchQuery.length > 0 && (
                <TouchableOpacity onPress={() => setPubSearchQuery('')} hitSlop={8}>
                  <Ionicons name="close-circle" size={16} color={colors.textMuted} />
                </TouchableOpacity>
              )}
            </View>
            <FlatList
              data={pubSearchResults}
              keyExtractor={(pub) => pub.id}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              initialNumToRender={20}
              windowSize={5}
              ListHeaderComponent={
                <TouchableOpacity
                  style={s.pubSearchRow}
                  onPress={() => selectFilterFromSearch(null)}
                  activeOpacity={0.7}
                >
                  <View style={[s.pubSearchIconWrap, { backgroundColor: colors.accentMuted }]}>
                    <Ionicons name="albums-outline" size={16} color={colors.accent} />
                  </View>
                  <Text style={s.pubSearchName}>All sources</Text>
                  {!activeFilter && <Ionicons name="checkmark" size={18} color={colors.accent} />}
                </TouchableOpacity>
              }
              ListEmptyComponent={
                <Text style={s.pubSearchEmpty}>No sources match "{pubSearchQuery}"</Text>
              }
              ListFooterComponent={<View style={{ height: 24 }} />}
              renderItem={({ item: pub }) => {
                const active = activeFilter === pub.id;
                const isMuted = muted.has(pub.id);
                return (
                  <TouchableOpacity
                    style={s.pubSearchRow}
                    onPress={() => selectFilterFromSearch(active ? null : pub.id)}
                    onLongPress={() => { closePubSearch(); openPubSheet({ id: pub.id, name: pub.name, color: pub.color }); }}
                    delayLongPress={350}
                    activeOpacity={0.7}
                  >
                    {isMuted
                      ? <Ionicons name="volume-mute-outline" size={18} color={colors.textMuted} style={{ width: 30 }} />
                      : <FaviconIcon feedUrl={pub.feedUrl} emoji={pub.emoji} size={20} />
                    }
                    <Text style={[s.pubSearchName, isMuted && { color: colors.textMuted }]} numberOfLines={1}>
                      {pub.name}
                    </Text>
                    {active && <Ionicons name="checkmark" size={18} color={pub.color} />}
                  </TouchableOpacity>
                );
              }}
            />
          </Animated.View>
        </Modal>
      )}

    </View>
  );
}

function createFeedStyles(colors: ReturnType<typeof useColors>) { return StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgDeep },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md },
  loadingText: { ...T.body, color: colors.textMuted },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.sm,
  },
  headerDate: { ...T.label, color: colors.accent, marginBottom: 2 },
  headerTitle: { ...T.d2, color: colors.text },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  shuffleBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  shuffleBtnActive: { backgroundColor: colors.accentMuted, borderColor: colors.accentBorder },
  countBadge: {
    backgroundColor: colors.accentMuted, borderRadius: radius.full,
    paddingHorizontal: 12, paddingVertical: 5, borderWidth: 1, borderColor: colors.accentBorder,
  },
  countText: { ...T.badge, color: colors.accent },

  // Tab bar — full width, no horizontal margin so HALF_W math is exact
  tabBar: {
    flexDirection: 'row', position: 'relative', marginBottom: 4,
  },
  tabBtn: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  tabLabel: { ...T.h3, color: colors.textMuted },
  tabLabelActive: { color: colors.text, fontWeight: '700' },
  tabBorderLine: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 1, backgroundColor: colors.border },
  tabIndicator: { position: 'absolute', bottom: 0, left: 0, width: HALF_W, height: 2, backgroundColor: colors.accent, borderRadius: 1 },

  // Filter chips — properly sized, no uppercase
  filterScroll: { flexShrink: 0, flexGrow: 0 },
  filterRow: { paddingHorizontal: space.md, paddingTop: 6, paddingBottom: 10, gap: 8 },
  filterChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0,
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: radius.full, borderWidth: 1, borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  filterChipActive: { backgroundColor: colors.accentMuted, borderColor: colors.accentBorder },
  filterChipText: { fontSize: 13, fontWeight: '600' as const, color: colors.textSecondary, letterSpacing: 0 },
  filterChipTextActive: { color: colors.accent },
  filterEmoji: { fontSize: 14 },

  list: { paddingHorizontal: space.md, paddingBottom: 100 },

  // Hero card
  hero: {
    backgroundColor: colors.surface, borderRadius: radius.xl,
    borderWidth: 1, borderColor: colors.border, padding: space.md, overflow: 'hidden',
    ...shadow.card,
  },
  heroPubRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.sm },
  pubPill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: radius.full, borderWidth: 1,
    flexShrink: 1, maxWidth: '68%', overflow: 'hidden',
  },
  pubPillEmoji: { fontSize: 14 },
  pubPillText: { ...T.badge, letterSpacing: 0.5, flexShrink: 1 },
  heroImage: {
    width: '100%', height: 180, borderRadius: radius.md,
    marginBottom: space.sm, backgroundColor: colors.surfaceHigher,
  },
  heroTitle: { ...T.h1, color: colors.text, marginBottom: space.xs, lineHeight: 28 },
  heroExcerpt: { ...T.body, color: colors.textSecondary, lineHeight: 22, marginBottom: space.sm },
  heroMeta: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginBottom: space.sm },
  progressTrack: {
    height: 3, backgroundColor: colors.surfaceHigher,
    borderRadius: 2, overflow: 'hidden', marginBottom: space.xs,
  },
  progressFill: { height: 3, borderRadius: 2 },

  // Compact card
  card: {
    flexDirection: 'row', backgroundColor: colors.surface,
    borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden',
    ...shadow.card,
  },
  cardStrip: { width: 3 },
  cardBody: { flex: 1, padding: space.md },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  cardTopRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardPubRow: { flexDirection: 'row', alignItems: 'center', gap: 5, flex: 1, overflow: 'hidden' },
  cardPub: { ...T.label, flexShrink: 1 },
  cardExcerpt: { fontSize: 13, color: colors.textSecondary, lineHeight: 19, marginBottom: 8 },
  cardAge: { ...T.caption, color: colors.textMuted },
  cardRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', marginBottom: 8 },
  cardTitle: { ...T.h2, color: colors.text, lineHeight: 22 },
  cardThumb: {
    width: 72, height: 72, borderRadius: radius.md,
    backgroundColor: colors.surfaceHigher, flexShrink: 0,
  },
  cardBottom: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  readChip: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  metaChip: { ...T.caption, color: colors.textMuted },
  miniTrack: { flex: 1, height: 3, backgroundColor: colors.surfaceHigher, borderRadius: 2, overflow: 'hidden' },
  miniFill: { height: 3, borderRadius: 2 },

  // Inline follow button
  inlineFollowBtn: {
    paddingVertical: 3, paddingHorizontal: 8,
    borderRadius: radius.full, borderWidth: 1,
  },
  inlineFollowText: { fontSize: 11, fontWeight: '700' },

  // Swipe reveal backgrounds
  swipeBg: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.lg,
  },
  swipeSaveBg: { backgroundColor: '#16A34A', alignItems: 'flex-start', paddingLeft: 24 },
  swipeUnsaveBg: { backgroundColor: '#EF4444', alignItems: 'flex-start', paddingLeft: 24 },
  swipeHideBg: { backgroundColor: '#475569', alignItems: 'flex-end', paddingRight: 24 },
  swipeLabel: { color: 'white', fontSize: 11, fontWeight: '700', marginTop: 2 },

  // Scroll-to-top FAB
  scrollTopBtn: {
    position: 'absolute', bottom: 24, right: 20,
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: colors.accent,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },

  // Action sheet
  sheetBackdrop: { backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    borderTopWidth: 1, borderColor: colors.border,
    paddingHorizontal: space.lg, paddingTop: 12,
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 20, shadowOffset: { width: 0, height: -4 },
    elevation: 20,
  },
  sheetHandle: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: colors.border, alignSelf: 'center', marginBottom: 16,
  },
  sheetPubBadge: {
    alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 3,
    borderRadius: radius.full, borderWidth: 1, marginBottom: 8,
  },
  sheetPubName: { ...T.label, fontWeight: '700' },
  sheetTitle: { ...T.h2, color: colors.text, lineHeight: 24, marginBottom: 14 },
  sheetDivider: { height: 1, backgroundColor: colors.border, marginBottom: 8 },
  sheetRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: colors.border + '60',
  },
  sheetRowIcon: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  sheetRowLabel: { ...T.body, color: colors.text, flex: 1, marginBottom: 2 },
  sheetRowDesc: { ...T.caption, color: colors.textMuted },
  pubSearchHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  pubSearchInputWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.surfaceHigher, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, height: 42, marginBottom: 10,
  },
  pubSearchInput: { flex: 1, ...T.body, color: colors.text, padding: 0 },
  pubSearchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: colors.border + '60',
  },
  pubSearchIconWrap: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  pubSearchName: { ...T.body, color: colors.text, flex: 1 },
  pubSearchEmpty: { ...T.caption, color: colors.textMuted, textAlign: 'center', paddingVertical: 24 },

  emptyTitle: { ...T.h2, color: colors.text },
  emptySub: { ...T.body, color: colors.textMuted, textAlign: 'center' },
  emptyCta: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.accent, borderRadius: radius.full,
    paddingHorizontal: 20, paddingVertical: 12, marginTop: space.sm,
  },
  emptyCtaText: { ...T.h3, color: colors.bgDeep },

  loadMoreSection: { paddingTop: 20, paddingBottom: 16, gap: 10 },
  loadMoreHeading: { ...T.label, color: colors.textMuted, marginBottom: 4 },
  loadMoreBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingVertical: 14,
    borderRadius: radius.lg, borderWidth: 1,
  },
  loadMoreText: { ...T.body, fontWeight: '600' },

  // New posts pill
  newPostsPillRow: {
    position: 'absolute', top: 8, left: 0, right: 0, zIndex: 10,
    alignItems: 'center',
  },
  newPostsPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.accent, borderRadius: radius.full,
    paddingHorizontal: 14, paddingVertical: 8,
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
    elevation: 8,
  },
  newPostsPillText: { ...T.badge, color: colors.bg },

  // Continue reading strip
  continueStrip: { paddingTop: space.sm, marginBottom: 22, marginHorizontal: -space.md },
  continueTitle: { ...T.label, color: colors.textMuted, paddingHorizontal: space.md, marginBottom: space.sm },
  continueRow: { paddingHorizontal: space.md, gap: 10, paddingBottom: space.sm },
  continueCard: {
    width: 138, height: 90, backgroundColor: colors.surface,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    overflow: 'hidden',
  },
  continueCardBody: { flex: 1, padding: 9, paddingBottom: 6 },
  continuePubRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 5 },
  continuePubName: { fontSize: 10, fontWeight: '700' as const, flexShrink: 1 },
  continueCardTitle: { fontSize: 12, fontWeight: '600' as const, color: colors.text, lineHeight: 17 },
  continueProgressTrack: { height: 3, backgroundColor: colors.surfaceHigher },
  continueProgressFill: { height: 3 },
}); }
