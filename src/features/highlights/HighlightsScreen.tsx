import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  StatusBar, Animated, TextInput, ScrollView,
  Modal, Pressable, PanResponder, Share, KeyboardAvoidingView, Platform, Dimensions,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { format } from 'date-fns';

import { getAllHighlights, deleteHighlight, getRemoteMetaSync } from '../../data/db';
import {
  getAllBookHighlightsWithTitle, deleteBookHighlight, updateBookHighlightNote,
  type BookHighlightWithTitle,
} from '../../data/books';
import { PUBLICATIONS } from '../../data/publications';
import { type as T, space, radius, shadow } from '../../theme';
import { useColors } from '../../theme/ThemeContext';
import { RootStackParamList } from '../../navigation';
import { FaviconAvatar } from '../../components/FaviconAvatar';
import { AppAlert } from '../../components/AppAlert';

type ArticleHL = {
  id: number; article_id: string; selected_text: string; color: string;
  created_at: number; article_title: string | null; article_link: string | null;
  publication_id: string | null;
};
type Nav = NativeStackNavigationProp<RootStackParamList, 'Tabs'>;

const SWIPE_THRESHOLD = 88;
const PUB_SEARCH_H = Math.min(560, Dimensions.get('window').height * 0.75);
const CHIP_ROW_CAP = 30;

// Swipe left or right to delete — gray reveal bg, matching the Feed screen's swipe pattern.
// A completed swipe never deletes outright: it springs back and asks for confirmation
// (via onRequestDelete), since a swipe is easy to trigger by accident.
function SwipeableHighlightCard({ children, onRequestDelete }: { children: React.ReactNode; onRequestDelete: () => void }) {
  const translateX = useRef(new Animated.Value(0)).current;
  const hapticFired = useRef(false);

  // See FeedScreen's SwipeableCard for why this ref-forwarding is needed: the
  // PanResponder below is built once (useRef), so its callbacks would otherwise
  // permanently close over this card's first-render onRequestDelete.
  const onRequestDeleteRef = useRef(onRequestDelete);
  useEffect(() => { onRequestDeleteRef.current = onRequestDelete; });

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gs) =>
        Math.abs(gs.dx) > 6 && Math.abs(gs.dx) > Math.abs(gs.dy) * 1.8 && Math.abs(gs.dy) < 20,
      onPanResponderGrant: () => { hapticFired.current = false; },
      onPanResponderMove: (_, gs) => {
        translateX.setValue(gs.dx);
        if (!hapticFired.current && Math.abs(gs.dx) >= SWIPE_THRESHOLD) {
          hapticFired.current = true;
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        }
      },
      onPanResponderRelease: (_, gs) => {
        const crossed = Math.abs(gs.dx) >= SWIPE_THRESHOLD;
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true, tension: 120, friction: 12 }).start();
        if (crossed) onRequestDeleteRef.current();
      },
      onPanResponderTerminate: () => {
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
      },
      onPanResponderTerminationRequest: () => true,
    })
  ).current;

  // Whole background fades in as you swipe either direction...
  const bgOpacity = translateX.interpolate({
    inputRange: [-SWIPE_THRESHOLD, 0, SWIPE_THRESHOLD], outputRange: [1, 0, 1], extrapolate: 'clamp',
  });
  // ...but each icon lives pinned to the edge it reveals, and fades in from the very first
  // pixel of movement in that direction — not centered, and not hidden until halfway.
  const leftOpacity = translateX.interpolate({ inputRange: [0, SWIPE_THRESHOLD], outputRange: [0, 1], extrapolate: 'clamp' });
  const rightOpacity = translateX.interpolate({ inputRange: [-SWIPE_THRESHOLD, 0], outputRange: [1, 0], extrapolate: 'clamp' });
  const leftScale = translateX.interpolate({ inputRange: [0, SWIPE_THRESHOLD], outputRange: [0.6, 1], extrapolate: 'clamp' });
  const rightScale = translateX.interpolate({ inputRange: [-SWIPE_THRESHOLD, 0], outputRange: [1, 0.6], extrapolate: 'clamp' });

  return (
    <View style={{ overflow: 'hidden', borderRadius: radius.lg }}>
      <Animated.View style={[StyleSheet.absoluteFill, swipeStyles.bg, { opacity: bgOpacity }]}>
        {/* Left edge — revealed when swiping right */}
        <Animated.View style={[swipeStyles.side, { left: 0, opacity: leftOpacity, transform: [{ scale: leftScale }] }]}>
          <Ionicons name="trash" size={22} color="white" />
          <Text style={swipeStyles.label}>Delete</Text>
        </Animated.View>
        {/* Right edge — revealed when swiping left */}
        <Animated.View style={[swipeStyles.side, { right: 0, opacity: rightOpacity, transform: [{ scale: rightScale }] }]}>
          <Ionicons name="trash" size={22} color="white" />
          <Text style={swipeStyles.label}>Delete</Text>
        </Animated.View>
      </Animated.View>
      <Animated.View style={{ transform: [{ translateX }] }} {...pan.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}

const swipeStyles = StyleSheet.create({
  bg: {
    borderRadius: radius.lg,
    backgroundColor: '#475569',
  },
  side: {
    position: 'absolute', top: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
    gap: 4, paddingHorizontal: 24,
  },
  label: { color: 'white', fontSize: 11, fontWeight: '700', marginTop: 2 },
});

// Renders a text snippet with the matched portion highlighted
function MatchText({ text, query, baseStyle, matchBg }: {
  text: string; query: string; baseStyle: object; matchBg: string;
}) {
  if (!query.trim()) return <Text style={baseStyle}>"{text}"</Text>;
  const lower = text.toLowerCase();
  const lowerQ = query.toLowerCase().trim();
  const idx = lower.indexOf(lowerQ);
  if (idx < 0) return <Text style={baseStyle}>"{text}"</Text>;

  return (
    <Text style={baseStyle}>
      "{text.slice(0, idx)}
      <Text style={{ backgroundColor: matchBg, borderRadius: 3 }}>{text.slice(idx, idx + lowerQ.length)}</Text>
      {text.slice(idx + lowerQ.length)}"
    </Text>
  );
}

export default function HighlightsScreen() {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const nav = useNavigation<Nav>();

  const [tab, setTab] = useState<'articles' | 'books'>('articles');
  const [articleItems, setArticleItems] = useState<ArticleHL[]>([]);
  const [bookItems, setBookItems] = useState<BookHighlightWithTitle[]>([]);
  const [loading, setLoading] = useState(true);

  // Custom highlights menu sheet state
  type SelectedHL =
    | { type: 'article'; item: ArticleHL }
    | { type: 'book'; item: BookHighlightWithTitle };
  const [selectedHighlight, setSelectedHighlight] = useState<SelectedHL | null>(null);
  const [highlightMenuMounted, setHighlightMenuMounted] = useState(false);
  const highlightAnimY = useRef(new Animated.Value(500)).current;
  const highlightAnimBg = useRef(new Animated.Value(0)).current;

  // Inline note editor within the sheet (book highlights only)
  const [noteEditMode, setNoteEditMode] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');

  // Search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchOpacity = useRef(new Animated.Value(0)).current;

  // Filter state
  const [activePubId, setActivePubId] = useState<string | null>(null);
  const [activeBookId, setActiveBookId] = useState<string | null>(null);

  // Searchable filter list — same "find one by typing" fallback as the Feed page,
  // context-aware: sources on the Articles tab, books on the Books tab.
  const pubSearchAnimY = useRef(new Animated.Value(PUB_SEARCH_H)).current;
  const pubSearchAnimBg = useRef(new Animated.Value(0)).current;
  const [pubSearchMounted, setPubSearchMounted] = useState(false);
  const [pubSearchQuery, setPubSearchQuery] = useState('');

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

  useFocusEffect(useCallback(() => {
    setLoading(true);
    Promise.all([getAllHighlights(), getAllBookHighlightsWithTitle()]).then(([a, b]) => {
      setArticleItems(a as ArticleHL[]);
      setBookItems(b);
      setLoading(false);
    });
  }, []));

  function openSearch() {
    setSearchOpen(true);
    Animated.timing(searchOpacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
  }

  function closeSearch() {
    Animated.timing(searchOpacity, { toValue: 0, duration: 180, useNativeDriver: true }).start(() => {
      setSearchOpen(false);
      setSearchQuery('');
    });
  }

  function openHighlightMenu(hl: SelectedHL) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSelectedHighlight(hl);
    setNoteEditMode(false);
    highlightAnimY.setValue(500);
    highlightAnimBg.setValue(0);
    setHighlightMenuMounted(true);
    Animated.parallel([
      Animated.spring(highlightAnimY, { toValue: 0, useNativeDriver: true, tension: 80, friction: 13 }),
      Animated.timing(highlightAnimBg, { toValue: 1, duration: 220, useNativeDriver: true }),
    ]).start();
  }

  function closeHighlightMenu() {
    Animated.parallel([
      Animated.timing(highlightAnimY, { toValue: 500, duration: 260, useNativeDriver: true }),
      Animated.timing(highlightAnimBg, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start(() => {
      setHighlightMenuMounted(false);
      setSelectedHighlight(null);
      setNoteEditMode(false);
    });
  }

  async function performDelete(type: 'article' | 'book', id: number | string) {
    if (type === 'article') {
      await deleteHighlight(id as number);
      setArticleItems((prev) => prev.filter((h) => h.id !== id));
    } else {
      await deleteBookHighlight(id as string);
      setBookItems((prev) => prev.filter((h) => h.id !== id));
    }
  }

  async function handleDeleteSelectedHighlight() {
    if (!selectedHighlight) return;
    try {
      await performDelete(selectedHighlight.type, selectedHighlight.item.id);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (err) {
      console.error('Failed to delete highlight:', err);
      AppAlert.alert('Error', 'Failed to delete the highlight. Please try again.');
    }
    closeHighlightMenu();
  }

  async function handleSwipeDelete(type: 'article' | 'book', id: number | string) {
    try {
      await performDelete(type, id);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (err) {
      console.error('Failed to delete highlight:', err);
      AppAlert.alert('Error', 'Failed to delete the highlight. Please try again.');
    }
  }

  // Swiping is easy to trigger by accident, so it always confirms first. The bottom
  // sheet's delete (long-press → Delete Highlight) is already a deliberate multi-step
  // action, so it stays immediate — see handleDeleteSelectedHighlight.
  function confirmSwipeDelete(type: 'article' | 'book', id: number | string) {
    AppAlert.alert(
      'Delete highlight?',
      'This will permanently remove the highlight.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => handleSwipeDelete(type, id) },
      ],
    );
  }

  async function handleShareSelectedHighlight() {
    if (!selectedHighlight) return;
    const { type, item } = selectedHighlight;
    const quote = `"${item.selected_text}"`;
    const message = type === 'article'
      ? [quote, item.article_title ? `— ${item.article_title}` : null, item.article_link || null].filter(Boolean).join('\n')
      : [quote, `— ${item.book_title}`].join('\n');
    try {
      await Share.share({ message });
    } catch (err) {
      console.error('Failed to share highlight:', err);
    }
    closeHighlightMenu();
  }

  function handleOpenSourceSelectedHighlight() {
    if (!selectedHighlight) return;
    const { type, item } = selectedHighlight;
    closeHighlightMenu();
    if (type === 'article') {
      nav.navigate('Reader', { articleId: item.article_id, publicationId: item.publication_id ?? '', highlightId: item.id });
    } else {
      openBookHighlight(item);
    }
  }

  function openNoteEditor() {
    if (!selectedHighlight || selectedHighlight.type !== 'book') return;
    setNoteDraft(selectedHighlight.item.note ?? '');
    setNoteEditMode(true);
  }

  async function saveNoteEdit() {
    if (!selectedHighlight || selectedHighlight.type !== 'book') return;
    const id = selectedHighlight.item.id;
    const note = noteDraft.trim();
    try {
      await updateBookHighlightNote(id, note);
      setBookItems((prev) => prev.map((h) => (h.id === id ? { ...h, note: note || null } : h)));
    } catch (err) {
      console.error('Failed to update note:', err);
      AppAlert.alert('Error', 'Failed to save the note. Please try again.');
    }
    closeHighlightMenu();
  }

  function openBookHighlight(item: BookHighlightWithTitle) {
    if (!item.book_file_uri) {
      AppAlert.alert(
        'Book not on device',
        `"${item.book_title}" hasn't been imported on this device yet. Re-import the file to read it.`,
      );
      return;
    }
    nav.navigate('BookReader', { bookId: item.book_id, initialPage: item.page, highlightId: item.id });
  }

  // Unique publications from article highlights (for filter chips)
  const uniqueArticlePubs = useMemo(() => {
    const seen = new Map<string, { id: string; name: string; color: string; emoji: string; iconUrl: string }>();
    for (const h of articleItems) {
      const pubId = h.publication_id;
      if (!pubId || seen.has(pubId)) continue;
      const p = PUBLICATIONS.find((x) => x.id === pubId);
      const rm = !p ? getRemoteMetaSync(pubId) : null;
      seen.set(pubId, {
        id: pubId,
        name: p?.name ?? rm?.name ?? pubId,
        color: p?.color ?? rm?.color ?? colors.accent,
        emoji: p?.emoji ?? '📰',
        iconUrl: h.article_link || p?.feedUrl || rm?.feedUrl || '',
      });
    }
    return Array.from(seen.values());
  }, [articleItems, colors.accent]);

  // Unique books from book highlights
  const uniqueBooks = useMemo(() => {
    const seen = new Map<string, { id: string; title: string }>();
    for (const h of bookItems) {
      if (!seen.has(h.book_id)) {
        seen.set(h.book_id, { id: h.book_id, title: h.book_title });
      }
    }
    return Array.from(seen.values());
  }, [bookItems]);

  const pubSearchResults = pubSearchQuery.trim()
    ? uniqueArticlePubs.filter((p) => p.name.toLowerCase().includes(pubSearchQuery.trim().toLowerCase()))
    : uniqueArticlePubs;
  const bookSearchResults = pubSearchQuery.trim()
    ? uniqueBooks.filter((b) => b.title.toLowerCase().includes(pubSearchQuery.trim().toLowerCase()))
    : uniqueBooks;

  // Filtered + searched article highlights
  const filteredArticles = useMemo(() => {
    let list = articleItems;
    if (activePubId) list = list.filter((h) => h.publication_id === activePubId);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((h) => h.selected_text.toLowerCase().includes(q));
    }
    return list;
  }, [articleItems, activePubId, searchQuery]);

  // Filtered + searched book highlights
  const filteredBooks = useMemo(() => {
    let list = bookItems;
    if (activeBookId) list = list.filter((h) => h.book_id === activeBookId);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((h) => h.selected_text.toLowerCase().includes(q));
    }
    return list;
  }, [bookItems, activeBookId, searchQuery]);

  const total = tab === 'articles' ? filteredArticles.length : filteredBooks.length;

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bgDeep} />
      <LinearGradient colors={[colors.bgDeep, colors.bg]} style={StyleSheet.absoluteFill} />
      <SafeAreaView edges={['top']} style={{ flex: 1 }}>

        {/* ── Header ── */}
        <View style={s.header}>
          <TouchableOpacity onPress={() => nav.goBack()} hitSlop={12}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>

          {/* Stable flex:1 region — its bounds never change whether search is open or
              closed, so the close button never shifts during the animation. The search
              bar only fades + scales in/out inside it; the title overlays it when closed. */}
          <View style={{ flex: 1 }}>
            {searchOpen && (
              <Animated.View style={[s.searchContainer, {
                opacity: searchOpacity,
                transform: [{ scale: searchOpacity.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }],
              }]}>
                <TextInput
                  style={s.searchInput}
                  placeholder="Search highlights…"
                  placeholderTextColor={colors.textMuted}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  autoFocus
                  returnKeyType="search"
                />
              </Animated.View>
            )}
          </View>

          {/* Title — absolutely centered over the whole header, independent of side widths */}
          {!searchOpen && (
            <View style={s.headerTitleWrap} pointerEvents="none">
              <Text style={s.headerTitle}>Highlights</Text>
            </View>
          )}

          <View style={s.headerRight}>
            {/* Count badge — hides when search open */}
            {!searchOpen && (
              <View style={s.countBadge}>
                <Text style={s.countText}>{total}</Text>
              </View>
            )}

            {/* Search toggle */}
            <TouchableOpacity
              hitSlop={12}
              onPress={searchOpen ? closeSearch : openSearch}
              style={[s.iconBtn, searchOpen && { backgroundColor: colors.accentMuted, borderColor: colors.accentBorder }]}
            >
              <Ionicons
                name={searchOpen ? 'close' : 'search-outline'}
                size={18}
                color={searchOpen ? colors.accent : colors.textSecondary}
              />
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Tab toggle ── */}
        <View style={s.tabRow}>
          <TouchableOpacity
            style={[s.tabBtn, tab === 'articles' && s.tabBtnActive]}
            onPress={() => { setTab('articles'); setActiveBookId(null); }}
          >
            <Ionicons
              name="newspaper-outline"
              size={15}
              color={tab === 'articles' ? colors.accent : colors.textMuted}
            />
            <Text style={[s.tabLabel, tab === 'articles' && { color: colors.accent }]}>
              Articles
            </Text>
            {articleItems.length > 0 && (
              <View style={[s.tabCount, tab === 'articles' && { backgroundColor: colors.accentMuted, borderColor: colors.accentBorder }]}>
                <Text style={[s.tabCountText, tab === 'articles' && { color: colors.accent }]}>
                  {articleItems.length}
                </Text>
              </View>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[s.tabBtn, tab === 'books' && s.tabBtnActive]}
            onPress={() => { setTab('books'); setActivePubId(null); }}
          >
            <Ionicons
              name="library-outline"
              size={15}
              color={tab === 'books' ? colors.accent : colors.textMuted}
            />
            <Text style={[s.tabLabel, tab === 'books' && { color: colors.accent }]}>
              Books
            </Text>
            {bookItems.length > 0 && (
              <View style={[s.tabCount, tab === 'books' && { backgroundColor: colors.accentMuted, borderColor: colors.accentBorder }]}>
                <Text style={[s.tabCountText, tab === 'books' && { color: colors.accent }]}>
                  {bookItems.length}
                </Text>
              </View>
            )}
          </TouchableOpacity>
        </View>

        {/* ── Filter chips — Articles ── */}
        {tab === 'articles' && uniqueArticlePubs.length > 1 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.filterRow}
            style={s.filterScroll}
          >
            <TouchableOpacity style={s.filterChip} onPress={openPubSearch}>
              <Ionicons name="search-outline" size={14} color={colors.textMuted} />
              <Text style={s.filterChipText}>Search</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.filterChip, activePubId === null && s.filterChipAllActive]}
              onPress={() => setActivePubId(null)}
            >
              <Text style={[s.filterChipText, activePubId === null && { color: colors.accent }]}>All</Text>
            </TouchableOpacity>
            {uniqueArticlePubs.slice(0, CHIP_ROW_CAP).map((pub) => {
              const isActive = activePubId === pub.id;
              return (
                <TouchableOpacity
                  key={pub.id}
                  style={[s.filterChip, isActive && { backgroundColor: pub.color + '22', borderColor: pub.color + '60' }]}
                  onPress={() => setActivePubId(isActive ? null : pub.id)}
                  activeOpacity={0.7}
                >
                  <FaviconAvatar feedUrl={pub.iconUrl} emoji={pub.emoji} size={14} />
                  <Text style={[s.filterChipText, isActive && { color: pub.color }]} numberOfLines={1}>
                    {pub.name}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}

        {/* ── Filter chips — Books ── */}
        {tab === 'books' && uniqueBooks.length > 1 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.filterRow}
            style={s.filterScroll}
          >
            <TouchableOpacity style={s.filterChip} onPress={openPubSearch}>
              <Ionicons name="search-outline" size={14} color={colors.textMuted} />
              <Text style={s.filterChipText}>Search</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.filterChip, activeBookId === null && s.filterChipAllActive]}
              onPress={() => setActiveBookId(null)}
            >
              <Text style={[s.filterChipText, activeBookId === null && { color: colors.accent }]}>All</Text>
            </TouchableOpacity>
            {uniqueBooks.slice(0, CHIP_ROW_CAP).map((book) => {
              const isActive = activeBookId === book.id;
              return (
                <TouchableOpacity
                  key={book.id}
                  style={[s.filterChip, isActive && { backgroundColor: colors.accent + '22', borderColor: colors.accent + '60' }]}
                  onPress={() => setActiveBookId(isActive ? null : book.id)}
                >
                  <Ionicons name="book-outline" size={11} color={isActive ? colors.accent : colors.textMuted} />
                  <Text style={[s.filterChipText, isActive && { color: colors.accent }]} numberOfLines={1}>
                    {book.title}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}

        {/* ── Article highlights list ── */}
        {tab === 'articles' && (
          filteredArticles.length === 0 && !loading ? (
            <View style={s.empty}>
              <Ionicons name="color-wand-outline" size={48} color={colors.textMuted} />
              <Text style={s.emptyTitle}>
                {searchQuery.trim() ? 'No matches found' : 'No article highlights yet'}
              </Text>
              <Text style={s.emptySub}>
                {searchQuery.trim()
                  ? 'Try a different search term.'
                  : 'Select text while reading an article to save a highlight.'}
              </Text>
            </View>
          ) : (
            <FlatList
              data={filteredArticles}
              keyExtractor={(h) => String(h.id)}
              contentContainerStyle={s.list}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <SwipeableHighlightCard onRequestDelete={() => confirmSwipeDelete('article', item.id)}>
                  <TouchableOpacity
                    style={s.card}
                    onPress={() => nav.navigate('Reader', { articleId: item.article_id, publicationId: item.publication_id ?? '', highlightId: item.id })}
                    onLongPress={() => openHighlightMenu({ type: 'article', item })}
                    activeOpacity={0.8}
                  >
                    <View style={[s.colorBar, { backgroundColor: item.color }]} />
                    <View style={s.cardBody}>
                      <MatchText
                        text={item.selected_text}
                        query={searchQuery}
                        baseStyle={[s.highlightText, { borderLeftColor: item.color + '88' }] as object}
                        matchBg={item.color + '55'}
                      />
                      {item.article_title ? (
                        <Text style={s.sourceTitle} numberOfLines={1}>{item.article_title}</Text>
                      ) : null}
                      <View style={s.cardBottom}>
                        <Text style={s.date}>{format(new Date(item.created_at), 'MMM d, yyyy')}</Text>
                      </View>
                    </View>
                  </TouchableOpacity>
                </SwipeableHighlightCard>
              )}
            />
          )
        )}

        {/* ── Book highlights list ── */}
        {tab === 'books' && (
          filteredBooks.length === 0 && !loading ? (
            <View style={s.empty}>
              <Ionicons name="bookmark-outline" size={48} color={colors.textMuted} />
              <Text style={s.emptyTitle}>
                {searchQuery.trim() ? 'No matches found' : 'No book highlights yet'}
              </Text>
              <Text style={s.emptySub}>
                {searchQuery.trim()
                  ? 'Try a different search term.'
                  : 'Select text while reading a book to save a highlight.'}
              </Text>
            </View>
          ) : (
            <FlatList
              data={filteredBooks}
              keyExtractor={(h) => h.id}
              contentContainerStyle={s.list}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <SwipeableHighlightCard onRequestDelete={() => confirmSwipeDelete('book', item.id)}>
                  <TouchableOpacity
                    style={s.card}
                    onPress={() => openBookHighlight(item)}
                    onLongPress={() => openHighlightMenu({ type: 'book', item })}
                    activeOpacity={0.8}
                  >
                    <View style={[s.colorBar, { backgroundColor: item.color }]} />
                    <View style={s.cardBody}>
                      <MatchText
                        text={item.selected_text}
                        query={searchQuery}
                        baseStyle={[s.highlightText, { borderLeftColor: item.color + '88' }] as object}
                        matchBg={item.color + '55'}
                      />
                      {item.note ? (
                        <Text style={[s.noteLine, { color: colors.accent }]} numberOfLines={2}>
                          {item.note}
                        </Text>
                      ) : null}
                      <View style={s.bookMeta}>
                        <Ionicons name="library-outline" size={12} color={colors.textMuted} />
                        <Text style={s.sourceTitle} numberOfLines={1}>{item.book_title}</Text>
                        <Text style={[s.chapterLabel, { color: colors.textMuted }]}>
                          · Ch. {item.page + 1}
                        </Text>
                      </View>
                      <View style={s.cardBottom}>
                        <Text style={s.date}>{format(new Date(item.created_at), 'MMM d, yyyy')}</Text>
                      </View>
                    </View>
                    {/* Tap hint when book file is missing */}
                    {!item.book_file_uri && (
                      <View style={[s.missingChip, { backgroundColor: colors.surfaceHigher }]}>
                        <Ionicons name="cloud-offline-outline" size={11} color={colors.textMuted} />
                      </View>
                    )}
                  </TouchableOpacity>
                </SwipeableHighlightCard>
              )}
            />
          )
        )}
      </SafeAreaView>

      {/* ── Highlight Deletion Bottom Sheet Modal ── */}
      <Modal
        visible={highlightMenuMounted}
        transparent
        onRequestClose={closeHighlightMenu}
        statusBarTranslucent
        animationType="none"
      >
        {/* Modal opens its own native window on Android, so the screen-level
            adjustResize behavior doesn't reach it — the note editor's TextInput
            would otherwise sit right behind the keyboard with nothing pushing it up. */}
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.6)', opacity: highlightAnimBg }]}>
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={closeHighlightMenu} activeOpacity={1} />
        </Animated.View>
        {selectedHighlight && (() => {
          if (noteEditMode) {
            return (
              <Animated.View style={[s.modalSheet, { transform: [{ translateY: highlightAnimY }], position: 'absolute', bottom: 0, left: 0, right: 0 }]}>
                <Pressable style={{ width: '100%' }} onPress={() => {}}>
                  <View style={s.modalHandle} />

                  <Text style={s.modalTitle}>Edit Note</Text>
                  <Text style={s.modalSub}>Add a personal note to this highlight.</Text>

                  <TextInput
                    style={s.noteInput}
                    value={noteDraft}
                    onChangeText={setNoteDraft}
                    placeholder="Write a note…"
                    placeholderTextColor={colors.textMuted}
                    multiline
                    autoFocus
                  />

                  <View style={s.menuList}>
                    <TouchableOpacity style={[s.menuItem, { paddingVertical: 12 }]} onPress={saveNoteEdit}>
                      <View style={[s.menuIconWrap, { backgroundColor: colors.accentMuted, borderColor: colors.accentBorder }]}>
                        <Ionicons name="checkmark" size={20} color={colors.accent} />
                      </View>
                      <Text style={[s.menuLabel, { color: colors.accent, fontWeight: '600' }]}>Save Note</Text>
                    </TouchableOpacity>

                    <TouchableOpacity style={s.menuItem} onPress={() => setNoteEditMode(false)}>
                      <View style={s.menuIconWrap}>
                        <Ionicons name="close" size={20} color={colors.textSecondary} />
                      </View>
                      <Text style={s.menuLabel}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                </Pressable>
              </Animated.View>
            );
          }

          return (
            <Animated.View style={[s.modalSheet, { transform: [{ translateY: highlightAnimY }], position: 'absolute', bottom: 0, left: 0, right: 0 }]}>
              <Pressable style={{ width: '100%' }} onPress={() => {}}>
                {/* Drag handle */}
                <View style={s.modalHandle} />

                <Text style={s.modalTitle}>Highlight Options</Text>
                <Text style={s.modalSub} numberOfLines={2}>"{selectedHighlight.item.selected_text}"</Text>

                <View style={s.menuList}>
                  {/* Share */}
                  <TouchableOpacity style={s.menuItem} onPress={handleShareSelectedHighlight}>
                    <View style={s.menuIconWrap}>
                      <Ionicons name="share-outline" size={20} color={colors.textSecondary} />
                    </View>
                    <Text style={s.menuLabel}>Share Highlight</Text>
                  </TouchableOpacity>

                  {/* Open source */}
                  <TouchableOpacity style={s.menuItem} onPress={handleOpenSourceSelectedHighlight}>
                    <View style={s.menuIconWrap}>
                      <Ionicons
                        name={selectedHighlight.type === 'article' ? 'newspaper-outline' : 'book-outline'}
                        size={20}
                        color={colors.textSecondary}
                      />
                    </View>
                    <Text style={s.menuLabel}>
                      {selectedHighlight.type === 'article' ? 'Open Article' : 'Open Book'}
                    </Text>
                  </TouchableOpacity>

                  {/* Edit note — books only */}
                  {selectedHighlight.type === 'book' && (
                    <TouchableOpacity style={s.menuItem} onPress={openNoteEditor}>
                      <View style={s.menuIconWrap}>
                        <Ionicons name="create-outline" size={20} color={colors.textSecondary} />
                      </View>
                      <Text style={s.menuLabel}>
                        {selectedHighlight.item.note ? 'Edit Note' : 'Add Note'}
                      </Text>
                    </TouchableOpacity>
                  )}

                  <View style={s.menuDivider} />

                  {/* Confirm Delete */}
                  <TouchableOpacity
                    style={[s.menuItem, { paddingVertical: 12 }]}
                    onPress={handleDeleteSelectedHighlight}
                  >
                    <View style={[s.menuIconWrap, { backgroundColor: colors.danger + '18', borderColor: colors.danger + '44' }]}>
                      <Ionicons name="trash-outline" size={20} color={colors.danger} />
                    </View>
                    <Text style={[s.menuLabel, { color: colors.danger, fontWeight: '600' }]}>
                      Delete Highlight
                    </Text>
                  </TouchableOpacity>

                  {/* Cancel */}
                  <TouchableOpacity
                    style={s.menuItem}
                    onPress={closeHighlightMenu}
                  >
                    <View style={s.menuIconWrap}>
                      <Ionicons name="close" size={20} color={colors.textSecondary} />
                    </View>
                    <Text style={s.menuLabel}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </Pressable>
            </Animated.View>
          );
        })()}
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Searchable filter list (sources on Articles tab, books on Books tab) ── */}
      {pubSearchMounted && (
        <Modal transparent animationType="none" visible={pubSearchMounted} onRequestClose={closePubSearch} statusBarTranslucent>
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.6)', opacity: pubSearchAnimBg }]}>
            <TouchableOpacity style={StyleSheet.absoluteFill} onPress={closePubSearch} activeOpacity={1} />
          </Animated.View>
          <Animated.View
            style={[
              s.modalSheet,
              { height: PUB_SEARCH_H, transform: [{ translateY: pubSearchAnimY }], position: 'absolute', bottom: 0, left: 0, right: 0 },
            ]}
          >
            <View style={s.modalHandle} />
            <View style={s.pubSearchHeader}>
              <Text style={s.modalTitle}>{tab === 'articles' ? 'Filter by source' : 'Filter by book'}</Text>
              <TouchableOpacity onPress={closePubSearch} hitSlop={10}>
                <Ionicons name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <View style={s.pubSearchInputWrap}>
              <Ionicons name="search-outline" size={16} color={colors.textMuted} />
              <TextInput
                value={pubSearchQuery}
                onChangeText={setPubSearchQuery}
                placeholder={tab === 'articles' ? 'Search sources' : 'Search books'}
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
            {tab === 'articles' ? (
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
                    onPress={() => { setActivePubId(null); closePubSearch(); }}
                    activeOpacity={0.7}
                  >
                    <View style={[s.pubSearchIconWrap, { backgroundColor: colors.accentMuted }]}>
                      <Ionicons name="albums-outline" size={16} color={colors.accent} />
                    </View>
                    <Text style={s.pubSearchName}>All sources</Text>
                    {activePubId === null && <Ionicons name="checkmark" size={18} color={colors.accent} />}
                  </TouchableOpacity>
                }
                ListEmptyComponent={
                  <Text style={s.pubSearchEmpty}>No sources match "{pubSearchQuery}"</Text>
                }
                ListFooterComponent={<View style={{ height: 24 }} />}
                renderItem={({ item: pub }) => {
                  const active = activePubId === pub.id;
                  return (
                    <TouchableOpacity
                      style={s.pubSearchRow}
                      onPress={() => { setActivePubId(active ? null : pub.id); closePubSearch(); }}
                      activeOpacity={0.7}
                    >
                      <FaviconAvatar feedUrl={pub.iconUrl} emoji={pub.emoji} size={20} />
                      <Text style={s.pubSearchName} numberOfLines={1}>{pub.name}</Text>
                      {active && <Ionicons name="checkmark" size={18} color={pub.color} />}
                    </TouchableOpacity>
                  );
                }}
              />
            ) : (
              <FlatList
                data={bookSearchResults}
                keyExtractor={(book) => book.id}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                initialNumToRender={20}
                windowSize={5}
                ListHeaderComponent={
                  <TouchableOpacity
                    style={s.pubSearchRow}
                    onPress={() => { setActiveBookId(null); closePubSearch(); }}
                    activeOpacity={0.7}
                  >
                    <View style={[s.pubSearchIconWrap, { backgroundColor: colors.accentMuted }]}>
                      <Ionicons name="albums-outline" size={16} color={colors.accent} />
                    </View>
                    <Text style={s.pubSearchName}>All books</Text>
                    {activeBookId === null && <Ionicons name="checkmark" size={18} color={colors.accent} />}
                  </TouchableOpacity>
                }
                ListEmptyComponent={
                  <Text style={s.pubSearchEmpty}>No books match "{pubSearchQuery}"</Text>
                }
                ListFooterComponent={<View style={{ height: 24 }} />}
                renderItem={({ item: book }) => {
                  const active = activeBookId === book.id;
                  return (
                    <TouchableOpacity
                      style={s.pubSearchRow}
                      onPress={() => { setActiveBookId(active ? null : book.id); closePubSearch(); }}
                      activeOpacity={0.7}
                    >
                      <View style={[s.pubSearchIconWrap, { backgroundColor: colors.accentMuted }]}>
                        <Ionicons name="book-outline" size={16} color={colors.accent} />
                      </View>
                      <Text style={s.pubSearchName} numberOfLines={1}>{book.title}</Text>
                      {active && <Ionicons name="checkmark" size={18} color={colors.accent} />}
                    </TouchableOpacity>
                  );
                }}
              />
            )}
          </Animated.View>
        </Modal>
      )}
    </View>
  );
}

function createStyles(colors: ReturnType<typeof useColors>) { return StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgDeep },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 10, position: 'relative',
    paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: space.md,
  },
  headerTitleWrap: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { ...T.h2, color: colors.text },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  countBadge: {
    backgroundColor: colors.accentMuted, borderRadius: radius.full,
    paddingHorizontal: 10, paddingVertical: 3, borderWidth: 1, borderColor: colors.accentBorder,
  },
  countText: { ...T.badge, color: colors.accent },
  iconBtn: {
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },

  // Animated search bar
  searchContainer: {
    overflow: 'hidden',
    backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.accentBorder,
    paddingHorizontal: 10,
  },
  searchInput: {
    height: 44, ...T.body, color: colors.text,
    paddingVertical: 0, textAlignVertical: 'center',
  },

  tabRow: {
    flexDirection: 'row', marginHorizontal: space.md, marginBottom: space.sm,
    backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: 4, gap: 4,
  },
  tabBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 9, borderRadius: radius.md,
  },
  tabBtnActive: { backgroundColor: colors.surfaceHigher },
  tabLabel: { ...T.label, color: colors.textMuted, fontWeight: '600' },
  tabCount: {
    backgroundColor: colors.surfaceHigher, borderRadius: radius.full,
    paddingHorizontal: 7, paddingVertical: 1, borderWidth: 1, borderColor: colors.border,
  },
  tabCountText: { fontSize: 11, fontWeight: '700', color: colors.textMuted },

  // Filter chips
  filterScroll: { flexShrink: 0, flexGrow: 0, marginTop: 4, marginBottom: 6 },
  filterRow: { paddingHorizontal: space.md, paddingTop: 5, paddingBottom: 6, gap: 8 },
  filterChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0,
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: radius.full, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  filterChipAllActive: { backgroundColor: colors.accentMuted, borderColor: colors.accentBorder },
  filterChipText: { fontSize: 13, fontWeight: '600' as const, color: colors.textSecondary, letterSpacing: 0 },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, paddingHorizontal: space.xl },
  emptyTitle: { ...T.h2, color: colors.text },
  emptySub: { ...T.body, color: colors.textMuted, textAlign: 'center', lineHeight: 24 },

  list: { paddingHorizontal: space.md, paddingBottom: 100, gap: 12 },
  card: {
    flexDirection: 'row', backgroundColor: colors.surface,
    borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden',
  },
  colorBar: { width: 4 },
  cardBody: { flex: 1, padding: space.md },
  highlightText: {
    ...T.body, color: colors.text, lineHeight: 26, fontStyle: 'italic',
    borderLeftWidth: 3, paddingLeft: 10, marginBottom: 8,
  },
  noteLine: { ...T.caption, fontStyle: 'italic', marginBottom: 6, paddingLeft: 10 },
  bookMeta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 6 },
  sourceTitle: { ...T.label, color: colors.textMuted, flexShrink: 1 },
  chapterLabel: { ...T.caption },
  cardBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  date: { ...T.caption, color: colors.textMuted },
  missingChip: {
    position: 'absolute', top: 8, right: 8,
    width: 20, height: 20, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },

  // Bottom Sheet Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: space.lg,
    paddingBottom: 40,
    ...shadow.card,
  },
  modalHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: space.md,
  },
  modalTitle: {
    ...T.h2,
    color: colors.text,
    marginBottom: 4,
  },
  modalSub: {
    ...T.caption,
    color: colors.textMuted,
    marginBottom: space.md,
  },
  menuList: {
    gap: 2,
  },
  menuDivider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: 6,
  },
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
  noteInput: {
    ...T.body,
    color: colors.text,
    backgroundColor: colors.surfaceHigher,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.md,
    minHeight: 90,
    textAlignVertical: 'top',
    marginBottom: space.md,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  menuIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surfaceHigher,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuLabel: {
    ...T.body,
    fontSize: 16,
    color: colors.text,
  },
}); }
