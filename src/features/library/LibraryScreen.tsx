import React, { useCallback, useMemo, useState, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  StatusBar, ActivityIndicator, ScrollView, Animated,
  Modal, Pressable, Share, Linking, PanResponder,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useFocusEffect } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  getSavedArticles, unsaveArticle, type ArticleRow,
  getRemoteMetaSync, getAllRemoteSources, getProgressBatch,
  toggleArticleRead,
} from '../../data/db';
import { PUBLICATIONS } from '../../data/publications';
import { type as T, space, radius, shadow } from '../../theme';
import { useColors } from '../../theme/ThemeContext';
import { FaviconAvatar } from '../../components/FaviconAvatar';

const SWIPE_THRESHOLD = 88;

function SwipeableCard({
  children,
  onRemove,
}: {
  children: React.ReactNode;
  onRemove: () => void;
}) {
  const colors = useColors();
  const s = useMemo(() => createLibraryStyles(colors), [colors]);
  const translateX = useRef(new Animated.Value(0)).current;
  const hapticFired = useRef(false);

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gs) =>
        Math.abs(gs.dx) > 12 &&
        Math.abs(gs.dx) > Math.abs(gs.dy) * 2.2 &&
        Math.abs(gs.dy) < 15,
      onPanResponderGrant: () => { hapticFired.current = false; },
      onPanResponderMove: (_, gs) => {
        translateX.setValue(gs.dx);
        if (!hapticFired.current && Math.abs(gs.dx) >= SWIPE_THRESHOLD) {
          hapticFired.current = true;
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        }
      },
      onPanResponderRelease: (_, gs) => {
        if (Math.abs(gs.dx) >= SWIPE_THRESHOLD) {
          onRemove();
        }
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true, tension: 120, friction: 12 }).start();
      },
      onPanResponderTerminate: () => {
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
      },
      onPanResponderTerminationRequest: () => true,
    })
  ).current;

  // Background fades in if swiped in either direction
  const removeOpacity = translateX.interpolate({
    inputRange: [-SWIPE_THRESHOLD, 0, SWIPE_THRESHOLD],
    outputRange: [1, 0, 1],
    extrapolate: 'clamp',
  });
  const removeScale = translateX.interpolate({
    inputRange: [-SWIPE_THRESHOLD, 0, SWIPE_THRESHOLD],
    outputRange: [1, 0.6, 1],
    extrapolate: 'clamp',
  });

  // Fade left icon in on swipe right, and right icon in on swipe left
  const leftIconOpacity = translateX.interpolate({
    inputRange: [0, SWIPE_THRESHOLD],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const rightIconOpacity = translateX.interpolate({
    inputRange: [-SWIPE_THRESHOLD, 0],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  return (
    <View style={{ position: 'relative', overflow: 'hidden', borderRadius: radius.lg }}>
      <Animated.View style={[s.swipeBg, s.swipeRemoveBg, { opacity: removeOpacity }]}>
        {/* Left side trash (visible when swiping from left to right) */}
        <Animated.View style={{ transform: [{ scale: removeScale }], alignItems: 'center', gap: 4, paddingLeft: 24, opacity: leftIconOpacity }}>
          <Ionicons name="trash-outline" size={26} color="white" />
          <Text style={s.swipeLabel}>Remove</Text>
        </Animated.View>
        {/* Right side trash (visible when swiping from right to left) */}
        <Animated.View style={{ transform: [{ scale: removeScale }], alignItems: 'center', gap: 4, paddingRight: 24, opacity: rightIconOpacity }}>
          <Ionicons name="trash-outline" size={26} color="white" />
          <Text style={s.swipeLabel}>Remove</Text>
        </Animated.View>
      </Animated.View>
      <Animated.View style={{ transform: [{ translateX }], zIndex: 1 }} {...pan.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}

type Props = { navigation: NativeStackNavigationProp<any> };

export default function LibraryScreen({ navigation }: Props) {
  const colors = useColors();
  const s = useMemo(() => createLibraryStyles(colors), [colors]);
  const [saved, setSaved] = useState<ArticleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [progressMap, setProgressMap] = useState<Map<string, number>>(new Map());
  const [activePubId, setActivePubId] = useState<string | null>(null);

  // Bottom sheet modal state
  const [selectedArticle, setSelectedArticle] = useState<ArticleRow | null>(null);
  const [menuMounted, setMenuMounted] = useState(false);
  const menuAnimY = useRef(new Animated.Value(500)).current;
  const menuAnimBg = useRef(new Animated.Value(0)).current;

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

  function openArticleMenu(article: ArticleRow) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSelectedArticle(article);
    menuAnimY.setValue(500);
    menuAnimBg.setValue(0);
    setMenuMounted(true);
    Animated.parallel([
      Animated.spring(menuAnimY, { toValue: 0, useNativeDriver: true, tension: 80, friction: 13 }),
      Animated.timing(menuAnimBg, { toValue: 1, duration: 220, useNativeDriver: true }),
    ]).start();
  }

  function closeArticleMenu() {
    Animated.parallel([
      Animated.timing(menuAnimY, { toValue: 500, duration: 260, useNativeDriver: true }),
      Animated.timing(menuAnimBg, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start(() => {
      setMenuMounted(false);
      setSelectedArticle(null);
    });
  }

  async function handleToggleReadStatus(articleId: string, currentProg: number) {
    const isCompleted = currentProg >= 1;
    const nextCompleted = !isCompleted;
    await toggleArticleRead(articleId, nextCompleted);
    setProgressMap((prev) => {
      const next = new Map(prev);
      next.set(articleId, nextCompleted ? 1 : 0);
      return next;
    });
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    closeArticleMenu();
  }

  async function handleShareArticle(article: ArticleRow) {
    try {
      await Share.share({
        title: article.title,
        message: `${article.title}\n${article.link}`,
        url: article.link,
      });
    } catch {}
    closeArticleMenu();
  }

  function handleOpenInBrowser(url: string) {
    Linking.openURL(url).catch(() => {});
    closeArticleMenu();
  }

  async function handleRemoveArticle(articleId: string) {
    await handleUnsave(articleId);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    closeArticleMenu();
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

  // Build unique publications list from saved articles for the filter chips
  const uniquePubs = useMemo(() => {
    const seen = new Map<string, { id: string; name: string; color: string; emoji: string; iconUrl: string }>();
    for (const item of saved) {
      if (!seen.has(item.publication_id)) {
        const p = PUBLICATIONS.find((x) => x.id === item.publication_id);
        const rm = !p ? getRemoteMetaSync(item.publication_id) : null;
        seen.set(item.publication_id, {
          id: item.publication_id,
          name: p?.name ?? rm?.name ?? item.publication_id,
          color: p?.color ?? rm?.color ?? colors.accent,
          emoji: p?.emoji ?? '📰',
          iconUrl: item.link,
        });
      }
    }
    return Array.from(seen.values());
  }, [saved, colors.accent]);

  const filteredSaved = useMemo(() =>
    activePubId ? saved.filter((a) => a.publication_id === activePubId) : saved,
    [saved, activePubId],
  );

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

      {/* Publication filter chips */}
      {uniquePubs.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.filterRow}
          style={s.filterScroll}
        >
          <TouchableOpacity
            style={[s.filterChip, activePubId === null && s.filterChipActive]}
            onPress={() => setActivePubId(null)}
            activeOpacity={0.7}
          >
            <Text style={[s.filterChipText, activePubId === null && { color: colors.accent }]}>
              All
            </Text>
          </TouchableOpacity>
          {uniquePubs.map((pub) => {
            const isActive = activePubId === pub.id;
            return (
              <TouchableOpacity
                key={pub.id}
                style={[
                  s.filterChip,
                  isActive && { backgroundColor: pub.color + '22', borderColor: pub.color + '60' },
                ]}
                onPress={() => setActivePubId(isActive ? null : pub.id)}
                activeOpacity={0.7}
              >
                <FaviconAvatar feedUrl={pub.iconUrl} emoji={pub.emoji} size={14} />
                <Text
                  style={[s.filterChipText, isActive && { color: pub.color }]}
                  numberOfLines={1}
                >
                  {pub.name}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      {filteredSaved.length === 0 ? (
        <View style={s.empty}>
          <LinearGradient
            colors={[colors.accentMuted, 'transparent']}
            style={s.emptyIconRing}
          >
            <Ionicons name="bookmark-outline" size={40} color={colors.accent} />
          </LinearGradient>
          <Text style={s.emptyTitle}>
            {activePubId ? 'No saved articles from this source' : 'Nothing saved yet'}
          </Text>
          <Text style={s.emptySub}>
            {activePubId
              ? 'Try selecting a different publication filter.'
              : 'Bookmark articles to read them later — even offline.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={filteredSaved}
          keyExtractor={(a) => a.id}
          contentContainerStyle={s.list}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => {
            const pi = pubInfo(item);
            const c = pi.color;
            const prog = progressMap.get(item.id) ?? 0;
            return (
              <SwipeableCard onRemove={() => handleRemoveArticle(item.id)}>
                <TouchableOpacity
                  style={s.card}
                  onPress={() => openArticle(item)}
                  onLongPress={() => openArticleMenu(item)}
                  delayLongPress={360}
                  activeOpacity={0.8}
                >
                  <View style={s.cardInner}>
                    {/* Pub accent strip */}
                    <View style={[s.accentStrip, { backgroundColor: c }]} />

                    <View style={s.cardContent}>
                      <View style={s.cardTop}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, overflow: 'hidden' }}>
                          {/* Publication chip — icon + name with proper spacing */}
                          <View style={[s.pubChip, { backgroundColor: c + '18' }]}>
                            <FaviconAvatar feedUrl={pi.iconUrl} emoji={pi.emoji} size={14} />
                            <Text style={[s.pubChipText, { color: c }]} numberOfLines={1}>
                              {pi.name}
                            </Text>
                          </View>
                          <Text style={s.metaAge} numberOfLines={1}>{age(item.pub_date)}</Text>
                        </View>
                        <TouchableOpacity
                          style={s.unsaveBtn}
                          onPress={() => handleUnsave(item.id)}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                          <Ionicons name="bookmark" size={18} color={colors.accent} />
                        </TouchableOpacity>
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
                          {prog >= 1 && (
                            <View style={[s.metaPill, { backgroundColor: colors.success + '18' }]}>
                              <Ionicons name="checkmark-circle" size={12} color={colors.success} />
                              <Text style={[s.metaText, { color: colors.success }]}>Read</Text>
                            </View>
                          )}
                        </View>
                      </View>
                    </View>
                  </View>
                  {prog > 0.02 && (
                    <View style={s.progressTrack}>
                      <View style={[s.progressFill, { width: `${Math.round(prog * 100)}%` as any, backgroundColor: c }]} />
                    </View>
                  )}
                </TouchableOpacity>
              </SwipeableCard>
            );
          }}
        />
      )}

      {/* ── Context Menu Bottom Sheet Modal ── */}
      <Modal
        visible={menuMounted}
        transparent
        onRequestClose={closeArticleMenu}
        statusBarTranslucent
        animationType="none"
      >
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.6)', opacity: menuAnimBg }]}>
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={closeArticleMenu} activeOpacity={1} />
        </Animated.View>
        {selectedArticle && (() => {
          const pi = pubInfo(selectedArticle);
          const c = pi.color;
          const prog = progressMap.get(selectedArticle.id) ?? 0;
          const isCompleted = prog >= 1;

          return (
            <Animated.View style={[s.modalSheet, { transform: [{ translateY: menuAnimY }], position: 'absolute', bottom: 0, left: 0, right: 0 }]}>
              <Pressable style={{ width: '100%' }} onPress={() => {}}>
                {/* Drag handle */}
                <View style={s.modalHandle} />

                {/* Article Info */}
                <View style={s.menuHeader}>
                  <View style={[s.menuPubRow, { backgroundColor: c + '15' }]}>
                    <FaviconAvatar feedUrl={pi.iconUrl} emoji={pi.emoji} size={16} />
                    <Text style={[s.menuPubName, { color: c }]} numberOfLines={1}>
                      {pi.name}
                    </Text>
                  </View>
                  <Text style={s.menuTitle} numberOfLines={2}>
                    {selectedArticle.title}
                  </Text>
                </View>

                <View style={s.menuList}>
                  {/* Open in Reader */}
                  <TouchableOpacity
                    style={s.menuItem}
                    onPress={() => {
                      closeArticleMenu();
                      openArticle(selectedArticle);
                    }}
                  >
                    <View style={s.menuIconWrap}>
                      <Ionicons name="book-outline" size={20} color={colors.textSecondary} />
                    </View>
                    <Text style={s.menuLabel}>Open in Reader</Text>
                  </TouchableOpacity>

                  {/* Mark as read/unread */}
                  <TouchableOpacity
                    style={s.menuItem}
                    onPress={() => handleToggleReadStatus(selectedArticle.id, prog)}
                  >
                    <View style={s.menuIconWrap}>
                      <Ionicons
                        name={isCompleted ? "bookmark-outline" : "checkmark-circle-outline"}
                        size={20}
                        color={colors.textSecondary}
                      />
                    </View>
                    <Text style={s.menuLabel}>
                      {isCompleted ? "Mark as unread" : "Mark as read"}
                    </Text>
                  </TouchableOpacity>

                  {/* Share article */}
                  <TouchableOpacity
                    style={s.menuItem}
                    onPress={() => handleShareArticle(selectedArticle)}
                  >
                    <View style={s.menuIconWrap}>
                      <Ionicons name="share-outline" size={20} color={colors.textSecondary} />
                    </View>
                    <Text style={s.menuLabel}>Share link</Text>
                  </TouchableOpacity>

                  {/* Open in browser */}
                  <TouchableOpacity
                    style={s.menuItem}
                    onPress={() => handleOpenInBrowser(selectedArticle.link)}
                  >
                    <View style={s.menuIconWrap}>
                      <Ionicons name="globe-outline" size={20} color={colors.textSecondary} />
                    </View>
                    <Text style={s.menuLabel}>Open in browser</Text>
                  </TouchableOpacity>

                  {/* Divider before destructive action */}
                  <View style={s.menuDivider} />

                  {/* Remove from library */}
                  <TouchableOpacity
                    style={[s.menuItem, { paddingVertical: 12 }]}
                    onPress={() => handleRemoveArticle(selectedArticle.id)}
                  >
                    <View style={[s.menuIconWrap, { backgroundColor: colors.flame + '18' }]}>
                      <Ionicons name="trash-outline" size={20} color={colors.flame} />
                    </View>
                    <Text style={[s.menuLabel, { color: colors.flame, fontWeight: '600' }]}>
                      Remove from library
                    </Text>
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

function createLibraryStyles(colors: ReturnType<typeof useColors>) { return StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgDeep },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingTop: 60, paddingHorizontal: space.lg, paddingBottom: space.sm,
  },
  headerTitle: { ...T.d2, color: colors.text, flex: 1 },
  countBadge: {
    backgroundColor: colors.accentMuted, borderRadius: radius.full,
    paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: colors.accentBorder,
  },
  countText: { ...T.badge, color: colors.accent },

  // Publication filter strip
  filterScroll: { flexShrink: 0, flexGrow: 0, marginTop: 4, marginBottom: 6 },
  filterRow: { paddingHorizontal: space.md, paddingTop: 5, paddingBottom: 6, gap: 8 },
  filterChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0,
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: radius.full, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  filterChipActive: {
    backgroundColor: colors.accentMuted, borderColor: colors.accentBorder,
  },
  filterChipText: { fontSize: 13, fontWeight: '600' as const, color: colors.textSecondary, letterSpacing: 0 },

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
  pubChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: radius.full,
    paddingHorizontal: 8, paddingVertical: 3, flexShrink: 1, maxWidth: '70%', overflow: 'hidden',
  },
  pubChipText: { ...T.badge, fontSize: 11, flexShrink: 1 },
  metaAge: { ...T.caption, color: colors.textMuted, flexShrink: 0 },
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

  // Bottom Sheet Context Menu styles
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
  menuHeader: {
    marginBottom: space.md,
    gap: 6,
  },
  menuPubRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.full,
    alignSelf: 'flex-start',
  },
  menuPubName: {
    ...T.badge,
    fontSize: 11,
    maxWidth: 150,
  },
  menuTitle: {
    ...T.h2,
    color: colors.text,
    lineHeight: 24,
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
  menuDivider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: space.sm,
  },
  swipeBg: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg,
  },
  swipeRemoveBg: {
    backgroundColor: '#475569',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  swipeLabel: {
    color: 'white',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 2,
  },
}); }
