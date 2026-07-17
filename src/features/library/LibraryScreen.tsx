import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  StatusBar, ActivityIndicator, ScrollView, Animated,
  Modal, Pressable, Share, Linking, PanResponder,
  NativeScrollEvent, NativeSyntheticEvent, TextInput, Dimensions,
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
import { AppAlert } from '../../components/AppAlert';

const SWIPE_THRESHOLD = 88;
const SCROLL_TOP_THRESHOLD = 400;
const PUB_SEARCH_H = Math.min(560, Dimensions.get('window').height * 0.75);
const CHIP_ROW_CAP = 30;

// A completed swipe never removes outright: it springs back and asks for confirmation
// via onRequestRemove, since a swipe is easy to trigger by accident.
function SwipeableCard({
  children,
  onRequestRemove,
}: {
  children: React.ReactNode;
  onRequestRemove: () => void;
}) {
  const colors = useColors();
  const s = useMemo(() => createLibraryStyles(colors), [colors]);
  const translateX = useRef(new Animated.Value(0)).current;
  const hapticFired = useRef(false);

  // See FeedScreen's SwipeableCard for why this ref-forwarding is needed: the
  // PanResponder below is built once (useRef), so its callbacks would otherwise
  // permanently close over this card's first-render onRequestRemove.
  const onRequestRemoveRef = useRef(onRequestRemove);
  useEffect(() => { onRequestRemoveRef.current = onRequestRemove; });

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
          onRequestRemoveRef.current();
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
  const flatListRef = useRef<FlatList>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);

  // Searchable publication filter list — same "find one by typing" fallback as the Feed page.
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

  function selectPubFromSearch(id: string | null) {
    setActivePubId(id);
    closePubSearch();
  }

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

  // ── Scroll-to-top ──────────────────────────────────────────────────────────

  function handleScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const y = e.nativeEvent.contentOffset.y;
    setShowScrollTop(y > SCROLL_TOP_THRESHOLD);
  }

  function scrollToTop() {
    flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }

  async function handleRemoveArticle(articleId: string) {
    await handleUnsave(articleId);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    closeArticleMenu();
  }

  // Swiping is easy to trigger by accident, so it always confirms first. The bottom
  // sheet's "Remove from Library" is already a deliberate multi-step action, so it
  // stays immediate — see the onPress wired directly to handleRemoveArticle below.
  function confirmSwipeRemove(article: ArticleRow) {
    AppAlert.alert(
      'Remove from Library?',
      `"${article.title}" will be removed from your saved articles.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => handleRemoveArticle(article.id) },
      ],
    );
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

  const pubSearchResults = pubSearchQuery.trim()
    ? uniquePubs.filter((p) => p.name.toLowerCase().includes(pubSearchQuery.trim().toLowerCase()))
    : uniquePubs;

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
          <TouchableOpacity style={s.filterChip} onPress={openPubSearch} activeOpacity={0.7}>
            <Ionicons name="search-outline" size={14} color={colors.textMuted} />
            <Text style={s.filterChipText}>Search</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.filterChip, activePubId === null && s.filterChipActive]}
            onPress={() => setActivePubId(null)}
            activeOpacity={0.7}
          >
            <Text style={[s.filterChipText, activePubId === null && { color: colors.accent }]}>
              All
            </Text>
          </TouchableOpacity>
          {uniquePubs.slice(0, CHIP_ROW_CAP).map((pub) => {
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
          ref={flatListRef}
          data={filteredSaved}
          keyExtractor={(a) => a.id}
          contentContainerStyle={s.list}
          showsVerticalScrollIndicator={false}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          renderItem={({ item }) => {
            const pi = pubInfo(item);
            const c = pi.color;
            const prog = progressMap.get(item.id) ?? 0;
            return (
              <SwipeableCard onRequestRemove={() => confirmSwipeRemove(item)}>
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

      {/* ── Scroll to top FAB ── */}
      {showScrollTop && (
        <TouchableOpacity style={s.scrollTopBtn} onPress={scrollToTop} activeOpacity={0.85}>
          <Ionicons name="arrow-up" size={20} color={colors.bg} />
        </TouchableOpacity>
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
                    <View style={[s.menuIconWrap, { backgroundColor: colors.danger + '18' }]}>
                      <Ionicons name="trash-outline" size={20} color={colors.danger} />
                    </View>
                    <Text style={[s.menuLabel, { color: colors.danger, fontWeight: '600' }]}>
                      Remove from library
                    </Text>
                  </TouchableOpacity>
                </View>
              </Pressable>
            </Animated.View>
          );
        })()}
      </Modal>

      {/* ── Searchable publication filter list ── */}
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
              <Text style={s.menuTitle}>Filter by source</Text>
              <TouchableOpacity onPress={closePubSearch} hitSlop={10}>
                <Ionicons name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <View style={s.pubSearchInputWrap}>
              <Ionicons name="search-outline" size={16} color={colors.textMuted} />
              <TextInput
                value={pubSearchQuery}
                onChangeText={setPubSearchQuery}
                placeholder="Search saved sources"
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
                <TouchableOpacity style={s.pubSearchRow} onPress={() => selectPubFromSearch(null)} activeOpacity={0.7}>
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
                    onPress={() => selectPubFromSearch(active ? null : pub.id)}
                    activeOpacity={0.7}
                  >
                    <FaviconAvatar feedUrl={pub.iconUrl} emoji={pub.emoji} size={20} />
                    <Text style={s.pubSearchName} numberOfLines={1}>{pub.name}</Text>
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
  scrollTopBtn: {
    position: 'absolute', bottom: 24, right: 20,
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: colors.accent,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
}); }
