import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Animated, Linking, Modal, Share,
  View, Text, StyleSheet, SectionList, TouchableOpacity,
  StatusBar, Image,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { format } from 'date-fns';
import * as Haptics from 'expo-haptics';

import { getAllBooks, type BookRow } from '../../data/books';
import {
  getReadHistory, type ReadHistoryRow,
  getAllRemoteSources, getRemoteMetaSync,
  isArticleSaved, saveArticle, unsaveArticle,
} from '../../data/db';
import { PUBLICATIONS } from '../../data/publications';
import { type as T, space, radius } from '../../theme';
import { useColors } from '../../theme/ThemeContext';
import { RootStackParamList } from '../../navigation';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Tabs'>;

function relativeDate(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 86400000) return 'Today';
  if (diff < 172800000) return 'Yesterday';
  return format(new Date(ts), 'MMM d, yyyy');
}

function progressPercent(b: BookRow): number {
  if (!b.total_pages) return 0;
  return Math.min(100, Math.round((b.current_page / b.total_pages) * 100));
}

interface SheetData {
  article: ReadHistoryRow;
  isSaved: boolean;
  pubName: string;
  pubColor: string;
}

export default function HistoryScreen() {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const nav = useNavigation<Nav>();

  const [tab, setTab] = useState<'books' | 'articles'>('books');
  const [books, setBooks] = useState<BookRow[]>([]);
  const [articleHistory, setArticleHistory] = useState<ReadHistoryRow[]>([]);

  // Action sheet
  const sheetAnimY = useRef(new Animated.Value(500)).current;
  const sheetAnimBg = useRef(new Animated.Value(0)).current;
  const [sheetMounted, setSheetMounted] = useState(false);
  const [sheetData, setSheetData] = useState<SheetData | null>(null);

  useFocusEffect(useCallback(() => {
    // Small delay lets any in-flight progress saves from Reader finish before we query
    const t = setTimeout(() => {
      Promise.all([getAllBooks(), getReadHistory(), getAllRemoteSources()]).then(([b, h]) => {
        setBooks(b.filter((bk) => bk.last_read_at !== null || bk.current_page > 0));
        setArticleHistory(h);
      });
    }, 250);
    return () => clearTimeout(t);
  }, []));

  // ── Books ──────────────────────────────────────────────────────────────
  const booksReading = books
    .filter((b) => !(b.total_pages > 0 && b.current_page >= b.total_pages) && b.current_page > 0)
    .sort((a, b) => (b.last_read_at ?? 0) - (a.last_read_at ?? 0));

  const booksCompleted = books
    .filter((b) => b.total_pages > 0 && b.current_page >= b.total_pages)
    .sort((a, b) => (b.last_read_at ?? 0) - (a.last_read_at ?? 0));

  const bookSections = [
    ...(booksReading.length > 0 ? [{ title: 'Currently Reading', data: booksReading }] : []),
    ...(booksCompleted.length > 0 ? [{ title: 'Completed', data: booksCompleted }] : []),
  ];

  // ── Articles ───────────────────────────────────────────────────────────
  const articlesCompleted = articleHistory.filter((a) => a.completed === 1);
  const articlesInProgress = articleHistory.filter(
    (a) => a.completed === 0 && (a.pages_read > 0 || a.scroll_depth > 0.05),
  );

  const articleSections = [
    ...(articlesInProgress.length > 0 ? [{ title: 'In Progress', data: articlesInProgress }] : []),
    ...(articlesCompleted.length > 0 ? [{ title: 'Completed', data: articlesCompleted }] : []),
  ];

  const totalBooks = booksReading.length + booksCompleted.length;
  const totalArticles = articlesInProgress.length + articlesCompleted.length;

  function resolvePub(pubId: string | null): { name: string; color: string } {
    if (!pubId) return { name: '', color: colors.accent };
    const curated = PUBLICATIONS.find((p) => p.id === pubId);
    if (curated) return { name: curated.name, color: curated.color };
    const remote = getRemoteMetaSync(pubId);
    if (remote) return { name: remote.name, color: remote.color };
    return { name: '', color: colors.accent };
  }

  async function openSheet(art: ReadHistoryRow) {
    const { name, color } = resolvePub(art.publication_id);
    const saved = await isArticleSaved(art.article_id);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSheetData({ article: art, isSaved: saved, pubName: name, pubColor: color });
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

  async function handleSheetAction(action: string) {
    if (!sheetData) return;
    const art = sheetData.article;
    closeSheet();
    if (action === 'save') {
      if (sheetData.isSaved) {
        await unsaveArticle(art.article_id);
      } else {
        await saveArticle(art.article_id);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } else if (action === 'share') {
      const title = art.title ?? art.article_id;
      const link = art.link ?? '';
      await Share.share({ message: link ? `${title}\n${link}` : title });
    } else if (action === 'browser' && art.link) {
      await Linking.openURL(art.link);
    }
  }

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bgDeep} />
      <LinearGradient colors={[colors.bgDeep, colors.bg]} style={StyleSheet.absoluteFill} />
      <SafeAreaView edges={['top']} style={{ flex: 1 }}>

        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity onPress={() => nav.goBack()} hitSlop={12}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={s.headerTitle}>Reading History</Text>
        </View>

        {/* Tab toggle */}
        <View style={s.tabRow}>
          <TouchableOpacity
            style={[s.tabBtn, tab === 'books' && s.tabBtnActive]}
            onPress={() => setTab('books')}
          >
            <Ionicons name="library-outline" size={15} color={tab === 'books' ? colors.accent : colors.textMuted} />
            <Text style={[s.tabLabel, tab === 'books' && { color: colors.accent }]}>Books</Text>
            {totalBooks > 0 && (
              <View style={[s.tabCount, tab === 'books' && { backgroundColor: colors.accentMuted, borderColor: colors.accentBorder }]}>
                <Text style={[s.tabCountText, tab === 'books' && { color: colors.accent }]}>{totalBooks}</Text>
              </View>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.tabBtn, tab === 'articles' && s.tabBtnActive]}
            onPress={() => setTab('articles')}
          >
            <Ionicons name="newspaper-outline" size={15} color={tab === 'articles' ? colors.accent : colors.textMuted} />
            <Text style={[s.tabLabel, tab === 'articles' && { color: colors.accent }]}>Articles</Text>
            {totalArticles > 0 && (
              <View style={[s.tabCount, tab === 'articles' && { backgroundColor: colors.accentMuted, borderColor: colors.accentBorder }]}>
                <Text style={[s.tabCountText, tab === 'articles' && { color: colors.accent }]}>{totalArticles}</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>

        {/* Stats row */}
        {tab === 'books' && totalBooks > 0 && (
          <View style={s.statsRow}>
            <View style={s.statChip}>
              <View style={[s.statDot, { backgroundColor: colors.accent }]} />
              <Text style={s.statLabel}>Reading</Text>
              <Text style={[s.statCount, { color: colors.accent }]}>{booksReading.length}</Text>
            </View>
            <View style={s.statDivider} />
            <View style={s.statChip}>
              <View style={[s.statDot, { backgroundColor: colors.success }]} />
              <Text style={s.statLabel}>Completed</Text>
              <Text style={[s.statCount, { color: colors.success }]}>{booksCompleted.length}</Text>
            </View>
          </View>
        )}
        {tab === 'articles' && totalArticles > 0 && (
          <View style={s.statsRow}>
            <View style={s.statChip}>
              <View style={[s.statDot, { backgroundColor: colors.accent }]} />
              <Text style={s.statLabel}>In Progress</Text>
              <Text style={[s.statCount, { color: colors.accent }]}>{articlesInProgress.length}</Text>
            </View>
            <View style={s.statDivider} />
            <View style={s.statChip}>
              <View style={[s.statDot, { backgroundColor: colors.success }]} />
              <Text style={s.statLabel}>Completed</Text>
              <Text style={[s.statCount, { color: colors.success }]}>{articlesCompleted.length}</Text>
            </View>
          </View>
        )}

        {/* ── Books list ── */}
        {tab === 'books' && (
          bookSections.length === 0 ? (
            <View style={s.empty}>
              <Ionicons name="library-outline" size={48} color={colors.textMuted} />
              <Text style={s.emptyTitle}>No reading history yet</Text>
              <Text style={s.emptySub}>Open a book and start reading to track your progress here.</Text>
            </View>
          ) : (
            <SectionList
              sections={bookSections}
              keyExtractor={(item) => item.id}
              contentContainerStyle={s.list}
              showsVerticalScrollIndicator={false}
              stickySectionHeadersEnabled={false}
              renderSectionHeader={({ section }) => (
                <Text style={s.sectionHeader}>{section.title}</Text>
              )}
              ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
              renderItem={({ item: book }) => {
                const pct = progressPercent(book);
                const isComplete = book.total_pages > 0 && book.current_page >= book.total_pages;
                const canOpen = !!book.file_uri;
                return (
                  <TouchableOpacity
                    style={[s.bookCard, { opacity: canOpen ? 1 : 0.6 }]}
                    onPress={() => canOpen
                      ? nav.navigate('BookReader', { bookId: book.id })
                      : null
                    }
                    activeOpacity={0.8}
                  >
                    {/* Cover */}
                    <View style={s.bookCoverWrap}>
                      {book.cover_uri ? (
                        <Image source={{ uri: book.cover_uri }} style={s.bookCover} resizeMode="cover" />
                      ) : (
                        <LinearGradient
                          colors={[colors.accentMuted, colors.surfaceHigher]}
                          style={s.bookCover}
                        >
                          <Ionicons name="book" size={22} color={colors.accent} />
                        </LinearGradient>
                      )}
                      {isComplete && (
                        <View style={[s.completeBadge, { backgroundColor: colors.success }]}>
                          <Ionicons name="checkmark" size={10} color="#fff" />
                        </View>
                      )}
                    </View>

                    {/* Info */}
                    <View style={s.bookInfo}>
                      <Text style={s.bookTitle} numberOfLines={2}>{book.title}</Text>
                      {book.author ? (
                        <Text style={s.bookAuthor} numberOfLines={1}>{book.author}</Text>
                      ) : null}

                      {book.total_pages > 0 ? (
                        <>
                          <View style={s.progTrack}>
                            <View style={[s.progFill, { width: `${pct}%`, backgroundColor: isComplete ? colors.success : colors.accent }]} />
                          </View>
                          <Text style={s.progLabel}>
                            {isComplete ? 'Completed' : `${pct}% · ch. ${book.current_page + 1} of ${book.total_pages}`}
                          </Text>
                        </>
                      ) : null}

                      {book.last_read_at ? (
                        <Text style={s.dateLabel}>{relativeDate(book.last_read_at)}</Text>
                      ) : null}

                      {!canOpen && (
                        <View style={s.missingRow}>
                          <Ionicons name="cloud-offline-outline" size={12} color={colors.textMuted} />
                          <Text style={s.missingText}>File not on device</Text>
                        </View>
                      )}
                    </View>

                    <Ionicons name="chevron-forward" size={16} color={canOpen ? colors.textMuted : 'transparent'} />
                  </TouchableOpacity>
                );
              }}
            />
          )
        )}

        {/* ── Articles list ── */}
        {tab === 'articles' && (
          articleSections.length === 0 ? (
            <View style={s.empty}>
              <Ionicons name="newspaper-outline" size={48} color={colors.textMuted} />
              <Text style={s.emptyTitle}>No article history yet</Text>
              <Text style={s.emptySub}>Articles you read will appear here.</Text>
            </View>
          ) : (
            <SectionList
              sections={articleSections}
              keyExtractor={(item) => item.article_id}
              contentContainerStyle={s.list}
              showsVerticalScrollIndicator={false}
              stickySectionHeadersEnabled={false}
              renderSectionHeader={({ section }) => (
                <Text style={s.sectionHeader}>{section.title}</Text>
              )}
              ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
              renderItem={({ item: art }) => {
                // total_pages=1 means scroll-mode (recordScrollProgress inserts total_pages=1, pages_read=0)
                // total_pages>1 means page-mode — use pages_read ratio
                const pct = art.completed
                  ? 100
                  : art.total_pages > 1
                    ? Math.round((art.pages_read / art.total_pages) * 100)
                    : Math.round(art.scroll_depth * 100);
                const { name: pub, color: pubColor } = resolvePub(art.publication_id);
                return (
                  <TouchableOpacity
                    style={s.articleCard}
                    onPress={() => art.title
                      ? nav.navigate('Reader', { articleId: art.article_id, publicationId: art.publication_id ?? '' })
                      : null
                    }
                    onLongPress={() => void openSheet(art)}
                    delayLongPress={380}
                    activeOpacity={0.8}
                  >
                    <View style={[s.articleAccent, { backgroundColor: pubColor }]} />
                    <View style={s.articleBody}>
                      <Text style={s.articleTitle} numberOfLines={2}>
                        {art.title ?? 'Article'}
                      </Text>
                      {pub ? <Text style={[s.articlePub, { color: pubColor }]} numberOfLines={1}>{pub}</Text> : null}
                      <View style={s.progTrack}>
                        <View style={[
                          s.progFill,
                          { width: `${pct}%`, backgroundColor: art.completed ? colors.success : colors.accent },
                        ]} />
                      </View>
                      <View style={s.articleMeta}>
                        <Text style={s.progLabel}>{art.completed ? 'Completed' : `${pct}% read`}</Text>
                        <Text style={s.dateLabel}>{relativeDate(art.last_read_at)}</Text>
                      </View>
                    </View>
                    {art.completed ? (
                      <View style={[s.completeBadge, { backgroundColor: colors.success, position: 'relative', top: 0, right: 0 }]}>
                        <Ionicons name="checkmark" size={10} color="#fff" />
                      </View>
                    ) : (
                      <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                    )}
                  </TouchableOpacity>
                );
              }}
            />
          )
        )}
      </SafeAreaView>

      {/* Long-press action sheet */}
      {sheetMounted && (
        <Modal transparent animationType="none" onRequestClose={closeSheet}>
          <Animated.View
            style={[StyleSheet.absoluteFill, s.backdrop, { opacity: sheetAnimBg }]}
          >
            <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={closeSheet} />
          </Animated.View>
          <Animated.View style={[s.sheet, { transform: [{ translateY: sheetAnimY }] }]}>
            <View style={s.sheetHandle} />
            {sheetData && (
              <>
                <Text style={s.sheetTitle} numberOfLines={2}>{sheetData.article.title ?? 'Article'}</Text>
                {sheetData.pubName ? (
                  <Text style={[s.sheetSub, { color: sheetData.pubColor }]}>{sheetData.pubName}</Text>
                ) : null}
                <View style={s.sheetDivider} />

                <TouchableOpacity style={s.sheetRow} onPress={() => void handleSheetAction('save')}>
                  <Ionicons
                    name={sheetData.isSaved ? 'bookmark' : 'bookmark-outline'}
                    size={22}
                    color={sheetData.isSaved ? colors.accent : colors.text}
                  />
                  <Text style={[s.sheetRowLabel, sheetData.isSaved && { color: colors.accent }]}>
                    {sheetData.isSaved ? 'Saved' : 'Save article'}
                  </Text>
                </TouchableOpacity>
                <View style={s.sheetDivider} />

                <TouchableOpacity style={s.sheetRow} onPress={() => void handleSheetAction('share')}>
                  <Ionicons name="share-outline" size={22} color={colors.text} />
                  <Text style={s.sheetRowLabel}>Share</Text>
                </TouchableOpacity>
                <View style={s.sheetDivider} />

                {sheetData.article.link ? (
                  <TouchableOpacity style={s.sheetRow} onPress={() => void handleSheetAction('browser')}>
                    <Ionicons name="open-outline" size={22} color={colors.text} />
                    <Text style={s.sheetRowLabel}>Open in browser</Text>
                  </TouchableOpacity>
                ) : null}
              </>
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
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: space.md, paddingVertical: space.sm,
  },
  headerTitle: { ...T.h2, color: colors.text, flex: 1 },

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

  statsRow: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: space.md, marginBottom: space.sm,
    backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: 12,
  },
  statChip: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  statDot: { width: 8, height: 8, borderRadius: 4 },
  statLabel: { ...T.label, color: colors.textMuted },
  statCount: { ...T.label, fontWeight: '700' },
  statDivider: { width: 1, height: 20, backgroundColor: colors.border, marginHorizontal: 4 },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, paddingHorizontal: space.xl },
  emptyTitle: { ...T.h2, color: colors.text },
  emptySub: { ...T.body, color: colors.textMuted, textAlign: 'center', lineHeight: 24 },

  list: { paddingHorizontal: space.md, paddingBottom: 100 },
  sectionHeader: {
    ...T.label, color: colors.textMuted, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.6,
    marginTop: space.md, marginBottom: space.sm,
  },

  // ── Books ──
  bookCard: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: space.md,
  },
  bookCoverWrap: { position: 'relative' },
  bookCover: {
    width: 56, height: 72, borderRadius: 6,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surfaceHigher,
  },
  completeBadge: {
    position: 'absolute', bottom: -4, right: -4,
    width: 18, height: 18, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: colors.surface,
  },
  bookInfo: { flex: 1 },
  bookTitle: { ...T.body, color: colors.text, fontWeight: '600', marginBottom: 2 },
  bookAuthor: { ...T.caption, color: colors.textMuted, marginBottom: 8 },
  progTrack: {
    height: 4, backgroundColor: colors.surfaceHigher, borderRadius: 2,
    overflow: 'hidden', marginBottom: 4,
  },
  progFill: { height: '100%', borderRadius: 2 },
  progLabel: { ...T.caption, color: colors.textMuted },
  dateLabel: { ...T.caption, color: colors.textMuted, marginTop: 2 },
  missingRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  missingText: { ...T.caption, color: colors.textMuted },

  // ── Articles ──
  articleCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, overflow: 'hidden',
  },
  articleAccent: { width: 4, alignSelf: 'stretch' },
  articleBody: { flex: 1, padding: space.md },
  articleTitle: { ...T.body, color: colors.text, fontWeight: '600', marginBottom: 2 },
  articlePub: { ...T.caption, color: colors.accent, marginBottom: 8 },
  articleMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },

  // ── Bottom sheet ──
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: colors.surface, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    paddingBottom: 32,
  },
  sheetHandle: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: colors.border, alignSelf: 'center', marginTop: 10, marginBottom: 4,
  },
  sheetTitle: { ...T.body, color: colors.text, fontWeight: '700', paddingHorizontal: space.md, paddingVertical: 10 },
  sheetSub: { ...T.caption, color: colors.textMuted, paddingHorizontal: space.md, marginBottom: 6 },
  sheetRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingHorizontal: space.md, paddingVertical: 14,
  },
  sheetRowLabel: { ...T.body, color: colors.text },
  sheetDivider: { height: 1, backgroundColor: colors.border, marginHorizontal: space.md },
}); }
