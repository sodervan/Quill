import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  StatusBar, Alert, Animated, TextInput, ScrollView,
  Modal, Pressable,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { format } from 'date-fns';

import { getAllHighlights, deleteHighlight, getRemoteMetaSync } from '../../data/db';
import {
  getAllBookHighlightsWithTitle, deleteBookHighlight,
  type BookHighlightWithTitle,
} from '../../data/books';
import { PUBLICATIONS } from '../../data/publications';
import { type as T, space, radius, shadow } from '../../theme';
import { useColors } from '../../theme/ThemeContext';
import { RootStackParamList } from '../../navigation';
import { FaviconAvatar } from '../../components/FaviconAvatar';

type ArticleHL = {
  id: number; article_id: string; selected_text: string; color: string;
  created_at: number; article_title: string | null; article_link: string | null;
  publication_id: string | null;
};
type Nav = NativeStackNavigationProp<RootStackParamList, 'Tabs'>;

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
  const [selectedHighlight, setSelectedHighlight] = useState<{ type: 'article' | 'book'; id: number | string; text: string } | null>(null);
  const [highlightMenuMounted, setHighlightMenuMounted] = useState(false);
  const highlightAnimY = useRef(new Animated.Value(500)).current;
  const highlightAnimBg = useRef(new Animated.Value(0)).current;

  // Search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchWidth = useRef(new Animated.Value(0)).current;
  const searchOpacity = useRef(new Animated.Value(0)).current;

  // Filter state
  const [activePubId, setActivePubId] = useState<string | null>(null);
  const [activeBookId, setActiveBookId] = useState<string | null>(null);

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
    Animated.parallel([
      Animated.spring(searchWidth, { toValue: 1, tension: 70, friction: 12, useNativeDriver: false }),
      Animated.timing(searchOpacity, { toValue: 1, duration: 180, useNativeDriver: false }),
    ]).start();
  }

  function closeSearch() {
    Animated.parallel([
      Animated.timing(searchWidth, { toValue: 0, duration: 220, useNativeDriver: false }),
      Animated.timing(searchOpacity, { toValue: 0, duration: 160, useNativeDriver: false }),
    ]).start(() => {
      setSearchOpen(false);
      setSearchQuery('');
    });
  }

  function openHighlightMenu(type: 'article' | 'book', id: number | string, text: string) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSelectedHighlight({ type, id, text });
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
    });
  }

  async function handleDeleteSelectedHighlight() {
    if (!selectedHighlight) return;
    const { type, id } = selectedHighlight;
    try {
      if (type === 'article') {
        await deleteHighlight(id as number);
        setArticleItems((prev) => prev.filter((h) => h.id !== id));
      } else {
        await deleteBookHighlight(id as string);
        setBookItems((prev) => prev.filter((h) => h.id !== id));
      }
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (err) {
      console.error('Failed to delete highlight:', err);
      Alert.alert('Error', 'Failed to delete the highlight. Please try again.');
    }
    closeHighlightMenu();
  }

  function openBookHighlight(item: BookHighlightWithTitle) {
    if (!item.book_file_uri) {
      Alert.alert(
        'Book not on device',
        `"${item.book_title}" hasn't been imported on this device yet. Re-import the file to read it.`,
      );
      return;
    }
    nav.navigate('BookReader', { bookId: item.book_id, initialPage: item.page });
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

          {/* Animated search input */}
          <Animated.View style={[s.searchContainer, {
            width: searchWidth.interpolate({ inputRange: [0, 1], outputRange: ['0%', '65%'] }),
            opacity: searchOpacity,
          }]}>
            {searchOpen && (
              <TextInput
                style={s.searchInput}
                placeholder="Search highlights…"
                placeholderTextColor={colors.textMuted}
                value={searchQuery}
                onChangeText={setSearchQuery}
                autoFocus
                returnKeyType="search"
              />
            )}
          </Animated.View>

          {/* Title — hides when search is open */}
          {!searchOpen && (
            <Text style={s.headerTitle}>Highlights</Text>
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
            <TouchableOpacity
              style={[s.filterChip, activePubId === null && s.filterChipAllActive]}
              onPress={() => setActivePubId(null)}
            >
              <Text style={[s.filterChipText, activePubId === null && { color: colors.accent }]}>All</Text>
            </TouchableOpacity>
            {uniqueArticlePubs.map((pub) => {
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
            <TouchableOpacity
              style={[s.filterChip, activeBookId === null && s.filterChipAllActive]}
              onPress={() => setActiveBookId(null)}
            >
              <Text style={[s.filterChipText, activeBookId === null && { color: colors.accent }]}>All</Text>
            </TouchableOpacity>
            {uniqueBooks.map((book) => {
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
                <TouchableOpacity
                  style={s.card}
                  onPress={() => nav.navigate('Reader', { articleId: item.article_id, publicationId: item.publication_id ?? '' })}
                  onLongPress={() => openHighlightMenu('article', item.id, item.selected_text)}
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
                      <TouchableOpacity onPress={() => openHighlightMenu('article', item.id, item.selected_text)} hitSlop={8}>
                        <Ionicons name="trash-outline" size={16} color={colors.textMuted} />
                      </TouchableOpacity>
                    </View>
                  </View>
                </TouchableOpacity>
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
                <TouchableOpacity
                  style={s.card}
                  onPress={() => openBookHighlight(item)}
                  onLongPress={() => openHighlightMenu('book', item.id, item.selected_text)}
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
                      <TouchableOpacity onPress={() => openHighlightMenu('book', item.id, item.selected_text)} hitSlop={8}>
                        <Ionicons name="trash-outline" size={16} color={colors.textMuted} />
                      </TouchableOpacity>
                    </View>
                  </View>
                  {/* Tap hint when book file is missing */}
                  {!item.book_file_uri && (
                    <View style={[s.missingChip, { backgroundColor: colors.surfaceHigher }]}>
                      <Ionicons name="cloud-offline-outline" size={11} color={colors.textMuted} />
                    </View>
                  )}
                </TouchableOpacity>
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
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.6)', opacity: highlightAnimBg }]}>
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={closeHighlightMenu} activeOpacity={1} />
        </Animated.View>
        {selectedHighlight && (() => {
          return (
            <Animated.View style={[s.modalSheet, { transform: [{ translateY: highlightAnimY }], position: 'absolute', bottom: 0, left: 0, right: 0 }]}>
              <Pressable style={{ width: '100%' }} onPress={() => {}}>
                {/* Drag handle */}
                <View style={s.modalHandle} />

                <Text style={s.modalTitle}>Delete Highlight?</Text>
                <Text style={s.modalSub}>This will permanently remove the highlight from Quill.</Text>

                <View style={s.menuList}>
                  {/* Confirm Delete */}
                  <TouchableOpacity
                    style={[s.menuItem, { paddingVertical: 12 }]}
                    onPress={handleDeleteSelectedHighlight}
                  >
                    <View style={[s.menuIconWrap, { backgroundColor: colors.flame + '18', borderColor: colors.flame + '44' }]}>
                      <Ionicons name="trash-outline" size={20} color={colors.flame} />
                    </View>
                    <Text style={[s.menuLabel, { color: colors.flame, fontWeight: '600' }]}>
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
      </Modal>
    </View>
  );
}

function createStyles(colors: ReturnType<typeof useColors>) { return StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgDeep },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: space.md, paddingVertical: space.sm,
  },
  headerTitle: { ...T.h2, color: colors.text, flex: 1 },
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
    overflow: 'hidden', flex: 1,
    backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.accentBorder,
    paddingHorizontal: 10,
  },
  searchInput: {
    height: 34, ...T.body, color: colors.text,
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
