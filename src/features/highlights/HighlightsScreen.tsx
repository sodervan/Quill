import React, { useCallback, useState } from 'react';
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
import { colors, type as T, space, radius } from '../../theme';
import { RootStackParamList } from '../../navigation';

type HL = { id: number; article_id: string; selected_text: string; color: string; created_at: number; article_title: string | null; article_link: string | null };
type Nav = NativeStackNavigationProp<RootStackParamList, 'Tabs'>;

export default function HighlightsScreen() {
  const nav = useNavigation<Nav>();
  const [items, setItems] = useState<HL[]>([]);
  const [loading, setLoading] = useState(true);

  useFocusEffect(useCallback(() => {
    getAllHighlights().then((rows) => { setItems(rows as HL[]); setLoading(false); });
  }, []));

  function confirmDelete(id: number) {
    Alert.alert('Remove highlight?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: async () => {
          await deleteHighlight(id);
          setItems((prev) => prev.filter((h) => h.id !== id));
        },
      },
    ]);
  }

  function openArticle(item: HL) {
    nav.navigate('Reader', { articleId: item.article_id, publicationId: '' });
  }

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bgDeep} />
      <LinearGradient colors={[colors.bgDeep, colors.bg]} style={StyleSheet.absoluteFill} />
      <SafeAreaView edges={['top']} style={{ flex: 1 }}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => nav.goBack()} hitSlop={12}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={s.headerTitle}>Highlights</Text>
          <View style={s.countBadge}>
            <Text style={s.countText}>{items.length}</Text>
          </View>
        </View>

        {items.length === 0 && !loading ? (
          <View style={s.empty}>
            <Ionicons name="color-wand-outline" size={48} color={colors.textMuted} />
            <Text style={s.emptyTitle}>No highlights yet</Text>
            <Text style={s.emptySub}>Select text while reading to save a highlight.</Text>
          </View>
        ) : (
          <FlatList
            data={items}
            keyExtractor={(h) => String(h.id)}
            contentContainerStyle={s.list}
            showsVerticalScrollIndicator={false}
            ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
            renderItem={({ item }) => (
              <TouchableOpacity style={s.card} onPress={() => openArticle(item)} activeOpacity={0.8}>
                <View style={[s.colorBar, { backgroundColor: item.color }]} />
                <View style={s.cardBody}>
                  <Text style={[s.highlightText, { borderLeftColor: item.color + '88' }]}>
                    "{item.selected_text}"
                  </Text>
                  {item.article_title ? (
                    <Text style={s.articleTitle} numberOfLines={1}>{item.article_title}</Text>
                  ) : null}
                  <View style={s.cardBottom}>
                    <Text style={s.date}>{format(new Date(item.created_at), 'MMM d, yyyy')}</Text>
                    <TouchableOpacity onPress={() => confirmDelete(item.id)} hitSlop={8}>
                      <Ionicons name="trash-outline" size={16} color={colors.textMuted} />
                    </TouchableOpacity>
                  </View>
                </View>
              </TouchableOpacity>
            )}
          />
        )}
      </SafeAreaView>
    </View>
  );
}

const s = StyleSheet.create({
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
  articleTitle: { ...T.label, color: colors.textMuted, marginBottom: 8 },
  cardBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  date: { ...T.caption, color: colors.textMuted },
});
