import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  StatusBar, Alert,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { format } from 'date-fns';

import { getAllHighlights, deleteHighlight } from '../../data/db';
import {
  getAllBookHighlightsWithTitle, deleteBookHighlight,
  type BookHighlightWithTitle,
} from '../../data/books';
import { type as T, space, radius } from '../../theme';
import { useColors } from '../../theme/ThemeContext';
import { RootStackParamList } from '../../navigation';

type ArticleHL = {
  id: number; article_id: string; selected_text: string; color: string;
  created_at: number; article_title: string | null; article_link: string | null;
};
type Nav = NativeStackNavigationProp<RootStackParamList, 'Tabs'>;

export default function HighlightsScreen() {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const nav = useNavigation<Nav>();

  const [tab, setTab] = useState<'articles' | 'books'>('articles');
  const [articleItems, setArticleItems] = useState<ArticleHL[]>([]);
  const [bookItems, setBookItems] = useState<BookHighlightWithTitle[]>([]);
  const [loading, setLoading] = useState(true);

  useFocusEffect(useCallback(() => {
    setLoading(true);
    Promise.all([getAllHighlights(), getAllBookHighlightsWithTitle()]).then(([a, b]) => {
      setArticleItems(a as ArticleHL[]);
      setBookItems(b);
      setLoading(false);
    });
  }, []));

  function confirmDeleteArticle(id: number) {
    Alert.alert('Remove highlight?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: async () => {
          await deleteHighlight(id);
          setArticleItems((prev) => prev.filter((h) => h.id !== id));
        },
      },
    ]);
  }

  function confirmDeleteBook(id: string) {
    Alert.alert('Remove highlight?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: async () => {
          await deleteBookHighlight(id);
          setBookItems((prev) => prev.filter((h) => h.id !== id));
        },
      },
    ]);
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

  const total = tab === 'articles' ? articleItems.length : bookItems.length;

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
          <Text style={s.headerTitle}>Highlights</Text>
          <View style={s.countBadge}>
            <Text style={s.countText}>{total}</Text>
          </View>
        </View>

        {/* Tab toggle */}
        <View style={s.tabRow}>
          <TouchableOpacity
            style={[s.tabBtn, tab === 'articles' && s.tabBtnActive]}
            onPress={() => setTab('articles')}
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
            onPress={() => setTab('books')}
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

        {/* Article highlights */}
        {tab === 'articles' && (
          articleItems.length === 0 && !loading ? (
            <View style={s.empty}>
              <Ionicons name="color-wand-outline" size={48} color={colors.textMuted} />
              <Text style={s.emptyTitle}>No article highlights yet</Text>
              <Text style={s.emptySub}>Select text while reading an article to save a highlight.</Text>
            </View>
          ) : (
            <FlatList
              data={articleItems}
              keyExtractor={(h) => String(h.id)}
              contentContainerStyle={s.list}
              showsVerticalScrollIndicator={false}
              ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={s.card}
                  onPress={() => nav.navigate('Reader', { articleId: item.article_id, publicationId: '' })}
                  activeOpacity={0.8}
                >
                  <View style={[s.colorBar, { backgroundColor: item.color }]} />
                  <View style={s.cardBody}>
                    <Text style={[s.highlightText, { borderLeftColor: item.color + '88' }]}>
                      "{item.selected_text}"
                    </Text>
                    {item.article_title ? (
                      <Text style={s.sourceTitle} numberOfLines={1}>{item.article_title}</Text>
                    ) : null}
                    <View style={s.cardBottom}>
                      <Text style={s.date}>{format(new Date(item.created_at), 'MMM d, yyyy')}</Text>
                      <TouchableOpacity onPress={() => confirmDeleteArticle(item.id)} hitSlop={8}>
                        <Ionicons name="trash-outline" size={16} color={colors.textMuted} />
                      </TouchableOpacity>
                    </View>
                  </View>
                </TouchableOpacity>
              )}
            />
          )
        )}

        {/* Book highlights */}
        {tab === 'books' && (
          bookItems.length === 0 && !loading ? (
            <View style={s.empty}>
              <Ionicons name="bookmark-outline" size={48} color={colors.textMuted} />
              <Text style={s.emptyTitle}>No book highlights yet</Text>
              <Text style={s.emptySub}>Select text while reading a book to save a highlight.</Text>
            </View>
          ) : (
            <FlatList
              data={bookItems}
              keyExtractor={(h) => h.id}
              contentContainerStyle={s.list}
              showsVerticalScrollIndicator={false}
              ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={s.card}
                  onPress={() => openBookHighlight(item)}
                  activeOpacity={0.8}
                >
                  <View style={[s.colorBar, { backgroundColor: item.color }]} />
                  <View style={s.cardBody}>
                    <Text style={[s.highlightText, { borderLeftColor: item.color + '88' }]}>
                      "{item.selected_text}"
                    </Text>
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
                      <TouchableOpacity onPress={() => confirmDeleteBook(item.id)} hitSlop={8}>
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
  countBadge: {
    backgroundColor: colors.accentMuted, borderRadius: radius.full,
    paddingHorizontal: 10, paddingVertical: 3, borderWidth: 1, borderColor: colors.accentBorder,
  },
  countText: { ...T.badge, color: colors.accent },

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

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, paddingHorizontal: space.xl },
  emptyTitle: { ...T.h2, color: colors.text },
  emptySub: { ...T.body, color: colors.textMuted, textAlign: 'center', lineHeight: 24 },

  list: { paddingHorizontal: space.md, paddingBottom: 100 },
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
}); }
