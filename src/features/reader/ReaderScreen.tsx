import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, Dimensions, Keyboard, Linking, ScrollView, StatusBar,
  StyleSheet, Text, TextInput, TouchableOpacity, TouchableWithoutFeedback, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import PagerView from 'react-native-pager-view';
import { WebView } from 'react-native-webview';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { format } from 'date-fns';

import { RootStackParamList } from '../../navigation';
import { type as T, space, radius } from '../../theme';
import { useColors, useTheme } from '../../theme/ThemeContext';
import { FaviconAvatar } from '../../components/FaviconAvatar';
import { PUBLICATIONS } from '../../data/publications';
import {
  getArticleById, recordPageRead, recordScrollProgress, updateArticleWordCount,
  logReadEvent, isArticleSaved, saveArticle, unsaveArticle,
  saveHighlight, getHighlightsForArticle, deleteHighlight, updateHighlight, type HighlightRow,
  getRemoteMetaSync, getProgress,
} from '../../data/db';
import { resolveArticleContent } from '../../data/extractor';

type Props = NativeStackScreenProps<RootStackParamList, 'Reader'>;

const { height: SCREEN_H, width: SCREEN_W } = Dimensions.get('window');
const LOOKUP_H = Math.min(Math.round(SCREEN_H * 0.85), 700);
const HL_LIST_H = Math.min(560, SCREEN_H * 0.72);
const HL_SHEET_H = Math.min(520, SCREEN_H * 0.68);
const READER_FONT = 18;
const READER_LINE = 30;

export default function ReaderScreen({ route, navigation }: Props) {
  const colors = useColors();
  const { isDark } = useTheme();
  const s = useMemo(() => createReaderStyles(colors), [colors]);
  const { articleId, publicationId, highlightId } = route.params;

  const [title, setTitle] = useState('');
  const [pages, setPages] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [useWebView, setUseWebView] = useState(false);
  const [articleUrl, setArticleUrl] = useState('');
  const [currentPage, setCurrentPage] = useState(0);
  const [pubDate, setPubDate] = useState<Date | null>(null);
  const [wordCount, setWordCount] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);
  const [rawHtml, setRawHtml] = useState<string | null>(null);
  const [scrollMode, setScrollMode] = useState<'pages' | 'scroll'>('scroll');
  const [scrollProgress, setScrollProgress] = useState(0);
  const [selectedText, setSelectedText] = useState('');
  const [highlights, setHighlights] = useState<HighlightRow[]>([]);
  const [stableHtml, setStableHtml] = useState('');
  const [webViewLoadError, setWebViewLoadError] = useState(false);

  // ── Reading theme (Default / Sepia / Night) ──
  type ReadingTheme = 'default' | 'sepia' | 'night';
  const [readingTheme, setReadingTheme] = useState<ReadingTheme>('default');
  const ARTICLE_THEMES: ReadingTheme[] = ['default', 'sepia', 'night'];
  const THEME_META: Record<ReadingTheme, { icon: string; color: string; label: string }> = {
    default: { icon: 'sunny-outline', color: colors.textMuted, label: 'Default' },
    sepia:   { icon: 'leaf-outline',  color: '#8B6040',        label: 'Sepia'   },
    night:   { icon: 'moon-outline',  color: '#7B9CC8',        label: 'Night'   },
  };
  function cycleTheme() {
    setReadingTheme((t) => ARTICLE_THEMES[(ARTICLE_THEMES.indexOf(t) + 1) % ARTICLE_THEMES.length]);
  }

  const readStartRef = useRef<number>(Date.now());
  const scrollDepthRef = useRef(0);
  const scrollModeDepthRef = useRef(0);
  const lastSavedScrollRef = useRef(0);
  const restoreDepthRef = useRef(0);
  const webViewRef = useRef<any>(null);
  const skipNextDeselectRef = useRef(false);

  const [lookupText, setLookupText] = useState('');
  const lookupAnimY = useRef(new Animated.Value(LOOKUP_H)).current;
  const lookupAnimBg = useRef(new Animated.Value(0)).current;
  const [lookupMounted, setLookupMounted] = useState(false);

  // ── Add/edit highlight sheet (mirrors the book reader's) ──
  const [sheetState, setSheetState] = useState<
    | { mode: 'add'; text: string }
    | { mode: 'edit'; highlight: HighlightRow }
    | null
  >(null);
  const [noteText, setNoteText] = useState('');
  const [selectedColor, setSelectedColor] = useState(HIGHLIGHT_COLORS[0].color);
  const sheetAnimY = useRef(new Animated.Value(HL_SHEET_H)).current;
  const sheetAnimBg = useRef(new Animated.Value(0)).current;
  const [sheetMounted, setSheetMounted] = useState(false);
  const [kbHeight, setKbHeight] = useState(0);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (e) => setKbHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKbHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);

  // ── Highlights list sheet ──
  const [listMounted, setListMounted] = useState(false);
  const listAnimY = useRef(new Animated.Value(HL_LIST_H)).current;
  const listAnimBg = useRef(new Animated.Value(0)).current;
  const [colorFilter, setColorFilter] = useState<string | null>(null);
  // Set when locating a highlight requires switching out of pages mode first — picked
  // up by onWebViewLoadEnd once the WebView (re)mounts in scroll mode.
  const pendingLocateIdRef = useRef<number | null>(null);

  const [initialPage, setInitialPage] = useState(0);

  const pub = PUBLICATIONS.find((p) => p.id === publicationId);
  const remoteMeta = pub ? null : getRemoteMetaSync(publicationId);
  const c = pub?.color ?? remoteMeta?.color ?? colors.accent;
  const pubName = pub?.name ?? remoteMeta?.name ?? 'Source';
  const pubEmoji = pub?.emoji ?? '📰';
  const [articleLink, setArticleLink] = useState('');

  useEffect(() => {
    async function load() {
      setWebViewLoadError(false);
      const article = await getArticleById(articleId);
      if (!article) { setLoading(false); return; }

      setTitle(article.title);
      setArticleLink(article.link);
      setArticleUrl(article.link);
      if (article.pub_date > 0) setPubDate(new Date(article.pub_date));
      const [isSaved, existingHighlights, savedProgress] = await Promise.all([
        isArticleSaved(articleId),
        getHighlightsForArticle(articleId),
        getProgress(articleId),
      ]);
      setSaved(isSaved);
      setHighlights(existingHighlights);

      if (savedProgress) {
        // Restore scroll position — prefer scroll_depth; fall back to page fraction
        let depth = savedProgress.scroll_depth ?? 0;
        if (depth < 0.02 && savedProgress.pages_read > 1 && savedProgress.total_pages > 0) {
          depth = (savedProgress.pages_read - 1) / savedProgress.total_pages;
        }
        restoreDepthRef.current = depth;
        setInitialPage(Math.max(0, savedProgress.pages_read - 1));
      }
      if (article.content_html) setRawHtml(article.content_html);
      readStartRef.current = Date.now();

      // First attempt: use feed-provided HTML or try extracting from the URL
      const content = await resolveArticleContent(article.link, article.content_html ?? undefined);

      if (!content || content.pages.length === 0) {
        // Content extraction failed (e.g. paywalled site). Try once more with a
        // fresh scrape (no cached HTML) before giving up and using the WebView.
        let scraped = null;
        if (article.content_html) {
          // We had HTML but it produced no readable pages — try the live URL
          scraped = await resolveArticleContent(article.link).catch(() => null);
        }

        if (scraped && scraped.pages.length > 0) {
          // Scrape succeeded — render in styled reader
          if (!article.word_count) await updateArticleWordCount(article.id, scraped.wordCount);
          setWordCount(scraped.wordCount);
          setPages(scraped.pages);
          setStableHtml(buildStyledHtml(
            scraped.html,
            article.title,
            true,
            existingHighlights,
            isDark,
          ));
        } else {
          // Upgrade http:// links for WebView — Android WebView in release builds may block cleartext
          setArticleUrl(article.link.startsWith('http://') ? article.link.replace('http://', 'https://') : article.link);
          setUseWebView(true);
        }
        setLoading(false);
        return;
      }

      if (!article.word_count) await updateArticleWordCount(article.id, content.wordCount);
      setWordCount(content.wordCount);
      setPages(content.pages);
      // Build HTML once with existing highlights baked in — never rebuilt on highlight changes
      setStableHtml(buildStyledHtml(
            content.html,
            article.title,
            true,
            existingHighlights,
            isDark,
            readingTheme,
          ));
          setLoading(false);
        }
        void load();
      }, [articleId, readingTheme]);

  useEffect(() => {
    return () => {
      const seconds = Math.floor((Date.now() - readStartRef.current) / 1000);
      void logReadEvent(articleId, seconds, scrollDepthRef.current);
      if (scrollModeDepthRef.current > 0) {
        void recordScrollProgress(articleId, scrollModeDepthRef.current);
      }
    };
  }, [articleId]);

  // Save scroll progress when leaving the screen so History sees it immediately on return
  useEffect(() => {
    return navigation.addListener('blur', () => {
      if (scrollModeDepthRef.current > lastSavedScrollRef.current) {
        lastSavedScrollRef.current = scrollModeDepthRef.current;
        void recordScrollProgress(articleId, scrollModeDepthRef.current);
      }
    });
  }, [navigation, articleId]);

  const onPageSelected = useCallback(
    async (e: { nativeEvent: { position: number } }) => {
      const page = e.nativeEvent.position;
      setCurrentPage(page);
      scrollDepthRef.current = (page + 1) / pages.length;
      if (pages.length > 0) await recordPageRead(articleId, page + 1, pages.length);
    },
    [articleId, pages.length],
  );

  async function toggleSave() {
    if (saved) { await unsaveArticle(articleId); setSaved(false); }
    else { await saveArticle(articleId); setSaved(true); }
  }

  // ── Add/edit highlight sheet ──
  function openHighlightSheet(state: NonNullable<typeof sheetState>) {
    if (state.mode === 'edit') {
      setNoteText(state.highlight.note ?? '');
      setSelectedColor(state.highlight.color);
    } else {
      setNoteText('');
      setSelectedColor(HIGHLIGHT_COLORS[0].color);
    }
    setSheetState(state);
    sheetAnimY.setValue(HL_SHEET_H);
    sheetAnimBg.setValue(0);
    setSheetMounted(true);
    Animated.parallel([
      Animated.spring(sheetAnimY, { toValue: 0, tension: 80, friction: 13, useNativeDriver: true }),
      Animated.timing(sheetAnimBg, { toValue: 1, duration: 220, useNativeDriver: true }),
    ]).start();
  }

  function closeHighlightSheet(cb?: () => void, restoreSelection = false) {
    Animated.parallel([
      Animated.timing(sheetAnimY, { toValue: HL_SHEET_H, duration: 260, useNativeDriver: true }),
      Animated.timing(sheetAnimBg, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start(() => {
      setSheetMounted(false);
      setSheetState(null);
      if (restoreSelection) {
        // Cancelling out of "add" (not a save) — bring the selection back so the
        // tooltip reappears and the user can reconsider, same as closing Look up.
        setTimeout(() => {
          webViewRef.current?.injectJavaScript(
            `if(window.__savedRange){try{var s=window.getSelection();s.removeAllRanges();s.addRange(window.__savedRange);}catch(e){}}true;`
          );
        }, 120);
      }
      cb?.();
    });
  }

  async function saveHighlightFromSheet() {
    if (!sheetState) return;
    const note = noteText.trim() || null;
    if (sheetState.mode === 'add') {
      const text = sheetState.text.trim();
      if (!text) { closeHighlightSheet(); return; }
      const newId = await saveHighlight(articleId, text, selectedColor, note);
      setHighlights((prev) => [...prev, {
        id: newId, article_id: articleId, selected_text: text, color: selectedColor, note, created_at: Date.now(),
      }]);
      // Inject mark directly into live DOM — no WebView reload, no scroll-to-top
      webViewRef.current?.injectJavaScript(buildInjectMarkJS(text, newId, selectedColor));
    } else {
      const { highlight } = sheetState;
      await updateHighlight(highlight.id, selectedColor, note);
      setHighlights((prev) => prev.map((h) => h.id === highlight.id ? { ...h, color: selectedColor, note } : h));
      // Update every fragment of the live mark — a highlight spanning a paragraph/list-item
      // break wraps each intersecting text node in its own <mark> sharing this id.
      webViewRef.current?.injectJavaScript(
        `(function(){var ms=document.querySelectorAll('mark[data-highlight-id="${highlight.id}"]');for(var i=0;i<ms.length;i++){ms[i].style.background='${selectedColor}55';}})();true;`
      );
    }
    closeHighlightSheet();
  }

  function deleteCurrentHighlight() {
    if (!sheetState || sheetState.mode !== 'edit') return;
    const id = sheetState.highlight.id;
    closeHighlightSheet(async () => {
      await deleteHighlight(id);
      setHighlights((prev) => prev.filter((h) => h.id !== id));
      webViewRef.current?.injectJavaScript(
        `(function(){var ms=document.querySelectorAll('mark[data-highlight-id="${id}"]');for(var i=0;i<ms.length;i++){var m=ms[i];var f=document.createDocumentFragment();while(m.firstChild)f.appendChild(m.firstChild);m.parentNode.replaceChild(f,m);}})();true;`
      );
    });
  }

  function openLookup(text: string) {
    // Set both the RN-side skip flag AND the JS-side suppress flag before clearing the
    // selection. The RN flag stops setSelectedText('') from firing; the JS flag stops
    // the selectionchange handler from nulling window.__savedRange (which we need for
    // re-highlighting after the lookup sheet closes).
    skipNextDeselectRef.current = true;
    webViewRef.current?.injectJavaScript(
      `window.__suppressRangeClear=true;var s=window.getSelection();if(s)s.removeAllRanges();true;`
    );
    setLookupText(text);
    setLookupMounted(true);
    Animated.parallel([
      Animated.spring(lookupAnimY, { toValue: 0, tension: 80, friction: 13, useNativeDriver: true }),
      Animated.timing(lookupAnimBg, { toValue: 1, duration: 220, useNativeDriver: true }),
    ]).start();
  }

  function closeLookup() {
    Animated.parallel([
      Animated.timing(lookupAnimY, { toValue: LOOKUP_H, duration: 260, useNativeDriver: true }),
      Animated.timing(lookupAnimBg, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start(() => {
      setLookupMounted(false);
      // Small delay so the article WebView regains focus before we restore the selection.
      // Without this, addRange() is a no-op because the view isn't yet active.
      setTimeout(() => {
        webViewRef.current?.injectJavaScript(
          `if(window.__savedRange){try{var s=window.getSelection();s.removeAllRanges();s.addRange(window.__savedRange);}catch(e){}}true;`
        );
      }, 120);
    });
  }

  // ── Highlights list sheet: open/close/locate ──
  function openList() {
    setListMounted(true);
    Animated.parallel([
      Animated.spring(listAnimY, { toValue: 0, tension: 80, friction: 13, useNativeDriver: true }),
      Animated.timing(listAnimBg, { toValue: 1, duration: 220, useNativeDriver: true }),
    ]).start();
  }

  function closeList(cb?: () => void) {
    Animated.parallel([
      Animated.timing(listAnimY, { toValue: HL_LIST_H, duration: 260, useNativeDriver: true }),
      Animated.timing(listAnimBg, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start(() => { setListMounted(false); cb?.(); });
  }

  function scrollToHighlightMark(id: number) {
    webViewRef.current?.injectJavaScript(`
      (function(){
        var id=${id}, tries=0;
        function go(){
          var el=document.querySelector('mark[data-highlight-id="'+id+'"]');
          if(el){ el.scrollIntoView({block:'center',behavior:'smooth'}); return; }
          if(tries<20){ tries++; setTimeout(go,120); }
        }
        setTimeout(go,150);
      })();true;
    `);
  }

  function locateHighlight(id: number) {
    closeList(() => {
      if (scrollMode !== 'scroll') {
        pendingLocateIdRef.current = id;
        setScrollMode('scroll');
        return;
      }
      scrollToHighlightMark(id);
    });
  }

  function onWebViewLoadEnd() {
    const depth = restoreDepthRef.current;

    if (pendingLocateIdRef.current != null) {
      const id = pendingLocateIdRef.current;
      pendingLocateIdRef.current = null;
      scrollToHighlightMark(id);
      return;
    }

    // Arriving from a highlight tap — scroll to the highlighted text instead of the
    // last-read position. Falls back to the normal depth-based restore if the mark
    // can't be found (e.g. it spanned a paragraph break and didn't re-apply on load).
    if (highlightId != null) {
      webViewRef.current?.injectJavaScript(`
        (function(){
          var id=${highlightId}, d=${depth.toFixed(4)}, tries=0;
          function go(){
            var el=document.querySelector('mark[data-highlight-id="'+id+'"]');
            if(el){ el.scrollIntoView({block:'center',behavior:'smooth'}); return; }
            if(tries<20){ tries++; setTimeout(go,120); return; }
            if(d>=0.02){
              var h=document.documentElement.scrollHeight;
              window.scrollTo({top:Math.round(d*h),behavior:'smooth'});
            }
          }
          setTimeout(go,250);
        })();
        true;
      `);
      return;
    }

    if (depth < 0.02) return;
    // Retry until scrollHeight is ready (images / fonts may still be loading)
    webViewRef.current?.injectJavaScript(`
      (function(){
        var d=${depth.toFixed(4)}, tries=0;
        function go(){
          var h=document.documentElement.scrollHeight;
          if(h>window.innerHeight*1.5||tries>20){
            window.scrollTo({top:Math.round(d*h),behavior:'smooth'});
          } else { tries++; setTimeout(go,120); }
        }
        setTimeout(go,250);
      })();
      true;
    `);
  }

  function onWebMessage(e: { nativeEvent: { data: string } }) {
    const raw = e.nativeEvent.data;
    try {
      const msg = JSON.parse(raw);
      // Only treat as a typed event if it's an object with a string type field
      if (msg && typeof msg === 'object' && typeof msg.type === 'string') {
        if (msg.type === 'text_selected') setSelectedText(msg.text ?? '');
        else if (msg.type === 'text_deselected') {
          if (skipNextDeselectRef.current) { skipNextDeselectRef.current = false; }
          else { setSelectedText(''); }
        }
        else if (msg.type === 'highlight_tap') {
          const h = highlights.find((x) => x.id === msg.id);
          if (h) openHighlightSheet({ mode: 'edit', highlight: h });
        }
        return;
      }
    } catch {}
    // Plain float string = scroll depth
    const depth = parseFloat(raw);
    if (!isNaN(depth)) {
      scrollDepthRef.current = depth;
      if (depth > scrollModeDepthRef.current) scrollModeDepthRef.current = depth;
      setScrollProgress(depth);
      // Save to DB every 10% advancement so History reflects progress immediately on back
      if (depth - lastSavedScrollRef.current >= 0.1) {
        lastSavedScrollRef.current = depth;
        void recordScrollProgress(articleId, depth);
      }
    }
  }

  const readMins = wordCount ? Math.max(1, Math.round(wordCount / 200)) : null;
  const progress = scrollMode === 'scroll'
    ? scrollProgress
    : (pages.length > 0 ? (currentPage + 1) / pages.length : 0);

  if (loading) {
    return (
      <View style={[s.root, s.centered]}>
        <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={s.loadingText}>Loading article…</Text>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <LinearGradient colors={[colors.bgDeep, colors.bg]} style={StyleSheet.absoluteFill} />

      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        {/* ── Top bar ── */}
        <View style={s.topBar}>
          <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={12}>
            <View style={s.iconCircle}>
              <Ionicons name="chevron-back" size={22} color={colors.text} />
            </View>
          </TouchableOpacity>

          <View style={[s.pubChip, { backgroundColor: c + '18', borderColor: c + '44' }]}>
            <FaviconAvatar feedUrl={articleLink || pub?.feedUrl || ''} emoji={pubEmoji} size={20} />
            <Text style={[s.pubName, { color: c }]} numberOfLines={1}>{pubName}</Text>
          </View>

          <View style={s.topRight}>
            {/* Scroll mode toggle */}
            {pages.length > 0 && (
              <TouchableOpacity
                onPress={() => setScrollMode((m) => m === 'pages' ? 'scroll' : 'pages')}
                hitSlop={12}
                style={s.iconCircle}
              >
                <Ionicons
                  name={scrollMode === 'pages' ? 'albums-outline' : 'reader-outline'}
                  size={18}
                  color={colors.textSecondary}
                />
              </TouchableOpacity>
            )}
            {/* Reading theme cycle */}
            <TouchableOpacity onPress={cycleTheme} hitSlop={12} style={s.iconCircle}>
              <Ionicons
                name={THEME_META[readingTheme].icon as any}
                size={18}
                color={THEME_META[readingTheme].color}
              />
            </TouchableOpacity>
            <TouchableOpacity onPress={toggleSave} hitSlop={12} style={s.iconCircle}>
              <Ionicons
                name={saved ? 'bookmark' : 'bookmark-outline'}
                size={18}
                color={saved ? colors.accent : colors.textSecondary}
              />
            </TouchableOpacity>
            <TouchableOpacity onPress={openList} hitSlop={12} style={[s.iconCircle, { position: 'relative' }]}>
              <Ionicons name="list-outline" size={18} color={colors.textSecondary} />
              {highlights.length > 0 && (
                <View style={[s.hlBadge, { backgroundColor: colors.accent }]}>
                  <Text style={[s.hlBadgeText, { color: colors.bg }]}>
                    {highlights.length > 99 ? '99+' : highlights.length}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Progress bar ── */}
        <View style={s.progressTrack}>
          <LinearGradient
            colors={[c, c + 'AA']}
            style={[s.progressFill, { width: `${progress * 100}%` as any }]}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
          />
        </View>

        {/* ── Article header ── */}
        <View style={s.articleHeader}>
          {pubDate && (
            <Text style={s.articleDate}>{format(pubDate, 'MMMM d, yyyy').toUpperCase()}</Text>
          )}
          <Text style={s.articleTitle} numberOfLines={3}>{title}</Text>
          {readMins && (
            <View style={s.readMeta}>
              <Ionicons name="time-outline" size={13} color={colors.textMuted} />
              <Text style={s.readMetaText}>{readMins} min read</Text>
              {wordCount && (
                <>
                  <Text style={s.readMetaDot}>·</Text>
                  <Text style={s.readMetaText}>{wordCount.toLocaleString()} words</Text>
                  {pages.length > 0 && (
                    <>
                      <Text style={s.readMetaDot}>·</Text>
                      <Text style={s.readMetaText}>{pages.length} pages</Text>
                    </>
                  )}
                </>
              )}
            </View>
          )}
        </View>

        <View style={s.divider} />

        {/* ── Content ── */}
        {useWebView ? (
          webViewLoadError ? (
            <View style={s.centered}>
              <Ionicons name="globe-outline" size={48} color={colors.textMuted} />
              <Text style={s.errorText}>Couldn't load this article</Text>
              <Text style={[s.loadingText, { textAlign: 'center', paddingHorizontal: 32 }]}>
                The page could not be reached. You can try opening it in your browser.
              </Text>
              <TouchableOpacity
                onPress={() => void Linking.openURL(articleUrl)}
                style={[s.pubChip, { backgroundColor: colors.accentMuted, borderColor: colors.accentBorder, gap: 6, marginTop: 8 }]}
              >
                <Ionicons name="open-outline" size={14} color={colors.accent} />
                <Text style={{ color: colors.accent, fontWeight: '700' }}>Open in browser</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <WebView
              source={{ uri: articleUrl }}
              style={{ flex: 1 }}
              onError={() => setWebViewLoadError(true)}
              onHttpError={(e) => { if (e.nativeEvent.statusCode >= 400) setWebViewLoadError(true); }}
              injectedJavaScript={DARK_MODE_CSS_JS}
              onMessage={() => {}}
            />
          )
        ) : pages.length === 0 ? (
          <View style={s.centered}>
            <Ionicons name="alert-circle-outline" size={48} color={colors.textMuted} />
            <Text style={s.errorText}>Could not load article</Text>
            <TouchableOpacity
              onPress={() => navigation.goBack()}
              style={[s.pubChip, { backgroundColor: colors.accentMuted, borderColor: colors.accentBorder }]}
            >
              <Text style={{ color: colors.accent, fontWeight: '700' }}>Go back</Text>
            </TouchableOpacity>
          </View>
        ) : scrollMode === 'scroll' ? (
          /* ── Vertical scroll / rich HTML mode ── */
          <WebView
            ref={webViewRef}
            source={{ html: stableHtml }}
            style={{ flex: 1, backgroundColor: THEME_BG[readingTheme] }}
            injectedJavaScript={READER_JS}
            onMessage={onWebMessage}
            onLoadEnd={onWebViewLoadEnd}
            showsVerticalScrollIndicator={false}
            originWhitelist={['*']}
          />
        ) : (
          /* ── Horizontal page mode ── */
          <PagerView
            style={{ flex: 1 }}
            initialPage={initialPage}
            onPageSelected={onPageSelected}
            orientation="horizontal"
          >
            {pages.map((text, i) => (
              <ScrollView
                key={i}
                style={[s.page, { backgroundColor: THEME_BG[readingTheme] }]}
                contentContainerStyle={s.pageContent}
                nestedScrollEnabled
                showsVerticalScrollIndicator={false}
              >
                <Text style={[s.bodyText, { color: THEME_TEXT[readingTheme] }]}>{text}</Text>
                {i === pages.length - 1 && (
                  <View style={s.finishedBadge}>
                    <LinearGradient colors={[colors.success + '20', 'transparent']} style={s.finishedGrad}>
                      <Ionicons name="checkmark-circle" size={32} color={colors.success} />
                      <Text style={s.finishedText}>Article complete</Text>
                      <Text style={s.finishedSub}>Counts toward your daily goal</Text>
                    </LinearGradient>
                  </View>
                )}
              </ScrollView>
            ))}
          </PagerView>
        )}

        {/* ── Selection tooltip ── rendered as flex sibling so RN touches aren't swallowed by WebView ── */}
        {scrollMode === 'scroll' && !useWebView && !sheetMounted && selectedText.length > 0 && (
          <View style={s.highlightBar}>
            <Text style={s.highlightBarLabel} numberOfLines={2}>
              "{selectedText}"
            </Text>
            <View style={s.highlightColors}>
              <TouchableOpacity
                style={s.highlightCta}
                onPress={() => {
                  const text = selectedText;
                  setSelectedText('');
                  // Clear the native selection (handles + copy/share/select-all menu) now that
                  // we're handing off to the sheet — __savedRange already has a clone for the
                  // mark injection, and __suppressRangeClear stops that clone being nulled out.
                  webViewRef.current?.injectJavaScript(
                    `window.__suppressRangeClear=true;var s=window.getSelection();if(s)s.removeAllRanges();true;`
                  );
                  openHighlightSheet({ mode: 'add', text });
                }}
                activeOpacity={0.85}
              >
                <Ionicons name="color-wand-outline" size={15} color={colors.bg} />
                <Text style={s.highlightCtaText}>Highlight</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => openLookup(selectedText)} style={s.lookupPill} hitSlop={8}>
                <Ionicons name="search-outline" size={15} color={colors.accent} />
                <Text style={s.lookupPillText}>Look up</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  setSelectedText('');
                  webViewRef.current?.injectJavaScript(
                    `window.__savedRange=null;var s=window.getSelection();if(s)s.removeAllRanges();true;`
                  );
                }}
                style={s.highlightDismiss}
                hitSlop={8}
              >
                <Ionicons name="close" size={16} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ── Footer (pages mode only) ── */}
        {pages.length > 0 && !useWebView && scrollMode === 'pages' && (
          <View style={s.footer}>
            <Text style={s.pageNum}>
              <Text style={{ color: c }}>{currentPage + 1}</Text>
              <Text style={s.pageTotal}> / {pages.length}</Text>
            </Text>
            <PageIndicator total={pages.length} current={currentPage} color={c} />
            <TouchableOpacity
              onPress={() => setScrollMode('scroll')}
              style={s.modeBtn}
              hitSlop={8}
            >
              <Ionicons name="reader-outline" size={16} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
        )}
        {scrollMode === 'scroll' && !useWebView && pages.length > 0 && (
          <View style={s.footer}>
            <TouchableOpacity
              onPress={() => setScrollMode('pages')}
              style={[s.modeBtn, { flexDirection: 'row', gap: 4, alignItems: 'center', paddingHorizontal: 12 }]}
            >
              <Ionicons name="albums-outline" size={16} color={colors.textMuted} />
              <Text style={{ ...T.caption, color: colors.textMuted }}>Switch to pages</Text>
            </TouchableOpacity>
          </View>
        )}
      </SafeAreaView>

      {/* ── Scroll-to-top FAB (scroll mode only, appears after scrolling down) ── */}
      {scrollMode === 'scroll' && !useWebView && scrollProgress > 0.08 && !lookupMounted && selectedText.length === 0 && (
        <TouchableOpacity
          style={s.scrollTopBtn}
          onPress={() => {
            webViewRef.current?.injectJavaScript("window.scrollTo({top:0,behavior:'smooth'});true;");
          }}
          activeOpacity={0.85}
        >
          <Ionicons name="arrow-up" size={20} color={colors.bg} />
        </TouchableOpacity>
      )}

      {/* ── Add/edit highlight sheet ── */}
      {sheetMounted && (
        <TouchableWithoutFeedback onPress={() => closeHighlightSheet(undefined, sheetState?.mode === 'add')}>
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.65)', opacity: sheetAnimBg }]} />
        </TouchableWithoutFeedback>
      )}
      {sheetMounted && (
        <Animated.View
          style={[
            s.hlSheet,
            { height: HL_SHEET_H, transform: [{ translateY: sheetAnimY }], bottom: kbHeight },
          ]}
        >
          <View style={s.lookupHandle} />
          <View style={s.hlSheetHeader}>
            <Text style={s.hlSheetTitle}>
              {sheetState?.mode === 'edit' ? 'Edit highlight' : 'Add highlight'}
            </Text>
            <TouchableOpacity onPress={() => closeHighlightSheet(undefined, sheetState?.mode === 'add')}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView style={{ flex: 1 }} contentContainerStyle={s.hlSheetBody} keyboardShouldPersistTaps="handled">
            {(sheetState?.mode === 'add' ? sheetState.text : sheetState?.mode === 'edit' ? sheetState.highlight.selected_text : '') ? (
              <View style={[s.hlQuoteBubble, { borderLeftColor: selectedColor }]}>
                <Text style={s.hlQuoteText} numberOfLines={4}>
                  "{sheetState?.mode === 'add' ? sheetState.text : sheetState?.mode === 'edit' ? sheetState.highlight.selected_text : ''}"
                </Text>
              </View>
            ) : null}

            <View style={s.hlColorRow}>
              {HIGHLIGHT_COLORS.map((hc) => (
                <TouchableOpacity
                  key={hc.color}
                  style={[s.hlColorDot, { backgroundColor: hc.color }, selectedColor === hc.color && s.hlColorDotSelected]}
                  onPress={() => setSelectedColor(hc.color)}
                />
              ))}
            </View>

            <TextInput
              style={s.hlNoteInput}
              placeholder="Add a note (optional)…"
              placeholderTextColor={colors.textMuted}
              multiline
              numberOfLines={4}
              value={noteText}
              onChangeText={setNoteText}
              textAlignVertical="top"
            />
          </ScrollView>

          <View style={s.hlSheetActions}>
            {sheetState?.mode === 'edit' && (
              <TouchableOpacity style={s.hlDeleteBtn} onPress={deleteCurrentHighlight}>
                <Ionicons name="trash-outline" size={18} color={colors.danger} />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[s.hlSaveBtn, { backgroundColor: selectedColor }]}
              onPress={saveHighlightFromSheet}
            >
              <Text style={s.hlSaveBtnText}>
                {sheetState?.mode === 'edit' ? 'Update' : 'Save highlight'}
              </Text>
            </TouchableOpacity>
          </View>
        </Animated.View>
      )}

      {/* ── Lookup / search sheet ── */}
      {lookupMounted && (
        <TouchableWithoutFeedback onPress={closeLookup}>
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.65)', opacity: lookupAnimBg }]} />
        </TouchableWithoutFeedback>
      )}
      {lookupMounted && (
        <Animated.View style={[s.lookupSheet, { transform: [{ translateY: lookupAnimY }] }]}>
          <View style={s.lookupHandle} />
          <View style={s.lookupHeader}>
            <Ionicons name="search-outline" size={16} color={colors.accent} />
            <Text style={s.lookupTitle} numberOfLines={1}>
              "{lookupText.slice(0, 60)}{lookupText.length > 60 ? '…' : ''}"
            </Text>
            <TouchableOpacity onPress={closeLookup} hitSlop={10}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <WebView
            source={{ uri: `https://www.google.com/search?q=${encodeURIComponent(lookupText)}` }}
            style={{ flex: 1 }}
          />
        </Animated.View>
      )}

      {/* ── Highlights list sheet ── */}
      {listMounted && (
        <TouchableWithoutFeedback onPress={() => closeList()}>
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.65)', opacity: listAnimBg }]} />
        </TouchableWithoutFeedback>
      )}
      {listMounted && (
        <Animated.View style={[s.hlListSheet, { height: HL_LIST_H, transform: [{ translateY: listAnimY }] }]}>
          <View style={s.lookupHandle} />
          <View style={s.hlListHeader}>
            <Text style={s.hlListTitle}>
              Highlights{highlights.length > 0 ? ` · ${highlights.length}` : ''}
            </Text>
            <TouchableOpacity onPress={() => closeList()} hitSlop={10}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          {highlights.length === 0 ? (
            <View style={s.hlListEmpty}>
              <Ionicons name="color-wand-outline" size={40} color={colors.textMuted} />
              <Text style={s.hlListEmptyText}>No highlights yet</Text>
              <Text style={s.hlListEmptySub}>Select text while reading to highlight it.</Text>
            </View>
          ) : (
            <>
              {[...new Set(highlights.map((h) => h.color))].length > 1 && (
                <View style={s.colorFilterRow}>
                  {[...new Set(highlights.map((h) => h.color))].map((c) => {
                    const active = colorFilter === c;
                    return (
                      <TouchableOpacity
                        key={c}
                        onPress={() => setColorFilter(active ? null : c)}
                        style={[
                          s.colorFilterDot, { backgroundColor: c },
                          active && { borderWidth: 2, borderColor: colors.text },
                        ]}
                      />
                    );
                  })}
                  {colorFilter && (
                    <TouchableOpacity onPress={() => setColorFilter(null)} hitSlop={8}>
                      <Ionicons name="close-circle" size={18} color={colors.textMuted} />
                    </TouchableOpacity>
                  )}
                </View>
              )}
              <ScrollView contentContainerStyle={{ paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
                {(colorFilter ? highlights.filter((h) => h.color === colorFilter) : highlights).map((h) => (
                  <TouchableOpacity
                    key={h.id}
                    style={s.hlItem}
                    onPress={() => locateHighlight(h.id)}
                    activeOpacity={0.75}
                  >
                    <View style={[s.hlAccent, { backgroundColor: h.color }]} />
                    <Text style={s.hlText} numberOfLines={3}>{h.selected_text}</Text>
                    <Ionicons name="locate-outline" size={18} color={colors.accent} />
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </>
          )}
        </Animated.View>
      )}
    </View>
  );
}

const HIGHLIGHT_COLORS = [
  { color: '#C8AA6E', label: 'Gold' },
  { color: '#34D399', label: 'Green' },
  { color: '#A78BFA', label: 'Purple' },
  { color: '#F472B6', label: 'Pink' },
];

/** Background colours for each reading theme — applied to WebView and page ScrollView */
const THEME_BG: Record<string, string> = {
  default: '#090C15',  // resolved at render from app dark/light; default is the dark bg
  sepia:   '#F5EDDA',
  night:   '#0D0D0D',
};

/** Body text colours for each reading theme (page mode only) */
const THEME_TEXT: Record<string, string> = {
  default: '#EDE8E0',
  sepia:   '#3D2B1A',
  night:   '#B0B8C8',
};

/**
 * Injected into every bare-URL WebView fallback.
 * Forces a dark background + readable text so sites that render white-bg pages
 * (like Philosophy Now) aren't jarring. The !important ensures it overrides
 * the site's own inline styles.
 */
const DARK_MODE_CSS_JS = `
(function() {
  var style = document.createElement('style');
  style.textContent = [
    'html, body { background-color: #090C15 !important; color: #EDE8E0 !important; }',
    'a { color: #C8AA6E !important; }',
    'img { max-width: 100% !important; height: auto !important; border-radius: 8px; }',
  ].join(' ');
  document.head && document.head.appendChild(style);
  // Re-apply after any deferred CSS loads
  setTimeout(function() { document.head && document.head.appendChild(style.cloneNode(true)); }, 800);
})();
true;
`;

const READER_JS = `
(function() {
  // Scroll depth tracking
  var last = 0;
  function reportScroll() {
    var h = document.documentElement.scrollHeight || document.body.scrollHeight;
    if (h <= 0) return;
    var depth = Math.min(1, (window.scrollY + window.innerHeight) / h);
    if (Math.abs(depth - last) > 0.01) {
      last = depth;
      window.ReactNativeWebView.postMessage(String(depth));
    }
  }
  window.addEventListener('scroll', reportScroll, { passive: true });

  // Text selection: save the live range into window.__savedRange so it can be used when the
  // color button is tapped. The cloned Range remains valid even after WebView focus is transferred to RN.
  // __suppressRangeClear: set from RN before programmatically clearing selection (e.g. for lookup)
  // so the deselect handler does NOT null out the range we want to preserve.
  window.__savedRange = null;
  window.__suppressRangeClear = false;
  var selTimeout;
  document.addEventListener('selectionchange', function() {
    clearTimeout(selTimeout);
    selTimeout = setTimeout(function() {
      var sel = window.getSelection();
      var text = sel ? sel.toString().trim() : '';
      if (text.length > 2) {
        try { window.__savedRange = sel.getRangeAt(0).cloneRange(); } catch(e) { window.__savedRange = null; }
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'text_selected', text: text }));
      } else {
        if (window.__suppressRangeClear) {
          window.__suppressRangeClear = false;
        } else {
          window.__savedRange = null;
        }
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'text_deselected' }));
      }
    }, 400);
  });

  // Tap on existing highlight → send id back to RN for removal prompt
  document.addEventListener('click', function(e) {
    var el = e.target;
    while (el && el.tagName !== 'MARK') el = el.parentElement;
    if (el && el.tagName === 'MARK' && el.dataset.highlightId) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'highlight_tap',
        id: parseInt(el.dataset.highlightId, 10),
      }));
      e.preventDefault();
    }
  });
})();
true;
`;

function buildInjectMarkJS(text: string, id: number, color: string): string {
  const css = `background:${color}55;border-radius:3px;padding:0 2px;cursor:pointer`;
  return `(function(){
  var id=${id},css=${JSON.stringify(css)};
  function makeMark(){
    var m=document.createElement('mark');
    m.setAttribute('data-highlight-id',String(id));
    m.style.cssText=css;
    return m;
  }
  // Primary: use the range saved at selection time (survives focus transfer to RN).
  // A selection that crosses paragraph/list-item boundaries produces a Range whose
  // start and end sit in different block elements. range.surroundContents() throws
  // on that (it can't wrap a range that only partially selects a non-text node), and
  // the old fallback (extractContents + stuff into one <mark>) moved block elements
  // like <p>/<li> INSIDE an inline <mark>, corrupting the layout. Instead, wrap each
  // intersecting text node in its own <mark> so paragraph/list structure never moves.
  var range=window.__savedRange;
  if(range){
    window.__savedRange=null;
    try{
      var root=range.commonAncestorContainer;
      var entries=[];
      if(root.nodeType===3){
        entries.push({node:root,start:range.startOffset,end:range.endOffset});
      }else{
        var tw=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
        var n;
        while(n=tw.nextNode()){
          if(!n.nodeValue||!range.intersectsNode(n))continue;
          if(n.parentNode&&n.parentNode.tagName==='MARK')continue;
          var st=(n===range.startContainer)?range.startOffset:0;
          var en=(n===range.endContainer)?range.endOffset:n.nodeValue.length;
          if(en>st)entries.push({node:n,start:st,end:en});
        }
      }
      if(entries.length===0)throw new Error('no text nodes in range');
      for(var i=0;i<entries.length;i++){
        var e=entries[i];
        var subRange=document.createRange();
        subRange.setStart(e.node,e.start);
        subRange.setEnd(e.node,e.end);
        subRange.surroundContents(makeMark());
      }
      window.getSelection().removeAllRanges();
      return;
    }catch(e){}
  }
  // Fallback: walk text nodes (works for simple single-node selections)
  var text=${JSON.stringify(text)};
  var walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  var node;
  while(node=walker.nextNode()){
    if(node.parentNode.tagName==='MARK')continue;
    var i=node.nodeValue.indexOf(text);
    if(i<0)continue;
    var before=node.nodeValue.slice(0,i);
    var after=node.nodeValue.slice(i+text.length);
    var mark2=makeMark();
    mark2.textContent=text;
    var p=node.parentNode;
    if(before)p.insertBefore(document.createTextNode(before),node);
    p.insertBefore(mark2,node);
    if(after)p.insertBefore(document.createTextNode(after),node);
    p.removeChild(node);
    break;
  }
  window.getSelection().removeAllRanges();
})();true;`;
}

function applyHighlightsToHtml(html: string, highlights: HighlightRow[]): string {
  let result = html;
  for (const h of highlights) {
    if (!h.selected_text.trim()) continue;
    const style = `background:${h.color}55;border-radius:3px;padding:0 2px;cursor:pointer`;
    // A highlight that spans a paragraph/list-item break has one or more newlines in
    // selected_text (that's how Selection.toString() joined text across block elements).
    // The raw HTML has real </p><p>/</li><li> tags in between, not a bare newline, so a
    // single regex over the whole string never matches and the highlight silently fails
    // to re-apply on reload — wrap each block's chunk separately instead, same as the
    // live in-DOM highlighting already does per text node.
    const chunks = h.selected_text.split(/\r?\n+/).map((c) => c.trim()).filter(Boolean);
    // Once a prior chunk has matched, only look for the next one after it — otherwise a
    // repeated name/phrase elsewhere in the article (e.g. an attribution mentioned twice)
    // could match every occurrence (with the 'g' flag) or the wrong one entirely, instead
    // of the one actually adjacent to the rest of this highlight.
    let searchFrom = 0;
    for (const chunk of chunks) {
      // Selection.toString() only captures plain text, so if this chunk's span in the
      // raw HTML has any inline markup inside it (a link, <em>, <strong>, ...) — common
      // in real article bodies, especially past the first sentence — a literal match on
      // the plain text fails silently. Match word-by-word instead, allowing any run of
      // whitespace/inline tags between words, then wrap whatever actually matched
      // (tags included — nesting inline elements inside <mark> is valid).
      const words = chunk.split(/\s+/).filter(Boolean)
        .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      if (words.length === 0) continue;
      const pattern = words.join('(?:\\s|<[^>]+>)+');
      try {
        const match = new RegExp(pattern).exec(result.slice(searchFrom));
        if (!match) continue;
        const start = searchFrom + match.index;
        const end = start + match[0].length;
        const wrapped = `<mark data-highlight-id="${h.id}" style="${style}">${match[0]}</mark>`;
        result = result.slice(0, start) + wrapped + result.slice(end);
        searchFrom = start + wrapped.length;
      } catch {}
    }
  }
  return result;
}

function decodeHtmlEntities(s: string): string {
  // Decode HTML entities before applying highlight regex so that text selected
  // in the browser (decoded Unicode) matches the stored HTML source.
  // &amp; is replaced last to avoid double-decoding sequences like &amp;mdash;
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ldquo;/g, '\u201C')
    .replace(/&rdquo;/g, '\u201D')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&ndash;/g, '\u2013')
    .replace(/&hellip;/g, '\u2026')
    .replace(/&bull;/g, '\u2022')
    .replace(/&copy;/g, '\u00A9')
    .replace(/&reg;/g, '\u00AE')
    .replace(/&trade;/g, '\u2122')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function buildStyledHtml(content: string, title: string, isHtml = false, highlights: HighlightRow[] = [], isDark = true, readingTheme = 'default'): string {
  // Per-theme colour overrides — sepia and night each have their own palette
  const themeMap: Record<string, { bg: string; text: string; textSec: string; textMut: string; accent: string; surface: string; surfHigh: string; divider: string; success: string }> = {
    sepia: {
      bg: '#F5EDDA', text: '#3D2B1A', textSec: '#6B4E2E', textMut: '#9A7B5A',
      accent: '#8B4513', surface: '#EDE0C4', surfHigh: '#E3D4B0',
      divider: 'rgba(61,43,26,0.15)', success: '#2E7D32',
    },
    night: {
      bg: '#0D0D0D', text: '#B0B8C8', textSec: '#6A7585', textMut: '#40474F',
      accent: '#7B9CC8', surface: '#131313', surfHigh: '#1A1A1A',
      divider: 'rgba(255,255,255,0.06)', success: '#4CAF50',
    },
  };

  const th = themeMap[readingTheme];
  const bg       = th?.bg       ?? (isDark ? '#090C15' : '#F5F4F0');
  const text     = th?.text     ?? (isDark ? '#EDE8E0' : '#1C1A17');
  const textSec  = th?.textSec  ?? (isDark ? '#8E96A9' : '#5C5750');
  const textMut  = th?.textMut  ?? (isDark ? '#505869' : '#9A9590');
  const accent   = th?.accent   ?? (isDark ? '#C8AA6E' : '#A67C3D');
  const surface  = th?.surface  ?? (isDark ? '#0E1525' : '#FFFFFF');
  const surfHigh = th?.surfHigh ?? (isDark ? '#131C2E' : '#F0EEE9');
  const divider  = th?.divider  ?? (isDark ? '#1A2540' : 'rgba(0,0,0,0.09)');
  const success  = th?.success  ?? (isDark ? '#34D399' : '#16A34A');

  const rawBody = isHtml
    ? decodeHtmlEntities(content)
    : content.split('\n\n').map((p) => `<p>${p}</p>`).join('');
  const body = highlights.length > 0 ? applyHighlightsToHtml(rawBody, highlights) : rawBody;
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: ${bg}; color: ${text}; font-family: -apple-system, system-ui, sans-serif;
    font-size: 18px; line-height: 1.7; padding: 20px 20px 80px; }
  h1,h2,h3,h4 { color: ${text}; margin: 1.4em 0 0.6em; font-weight: 700; line-height: 1.3; }
  p { margin-bottom: 1.2em; }
  img { max-width: 100%; border-radius: 10px; display: block; margin: 1.2em 0; }
  a { color: ${accent}; text-decoration: none; }
  blockquote { border-left: 3px solid ${accent}; padding: 8px 16px; margin: 1.2em 0;
    color: ${textSec}; font-style: italic; background: ${surface}; border-radius: 0 8px 8px 0; }
  pre, code { background: ${surfHigh}; padding: 4px 8px; border-radius: 6px;
    font-size: 14px; font-family: monospace; overflow-x: auto; color: ${text}; }
  pre { padding: 12px 16px; display: block; margin: 1em 0; }
  ul, ol { padding-left: 1.5em; margin-bottom: 1.2em; }
  li { margin-bottom: 0.4em; }
  figure { margin: 1.2em 0; }
  figcaption { font-size: 13px; color: ${textMut}; text-align: center; margin-top: 6px; }
  hr { border: none; border-top: 1px solid ${divider}; margin: 2em 0; }
  mark { border-radius: 3px; padding: 0 2px; }
  .finished { text-align:center; padding: 40px 20px; color: ${success}; font-size: 15px; }
</style></head><body>${body}
<div class="finished">✓ End of article</div>
</body></html>`;
}

function PageIndicator({ total, current, color }: { total: number; current: number; color: string }) {
  const colors = useColors();
  const pi = useMemo(() => StyleSheet.create({
    dot: { height: 6, borderRadius: 3 },
    track: { height: 4, backgroundColor: colors.surfaceHigher, borderRadius: 2, overflow: 'hidden' },
    fill: { height: 4, borderRadius: 2 },
  }), [colors]);
  if (total <= 8) {
    return (
      <View style={{ flexDirection: 'row', gap: 5, alignItems: 'center', flex: 1, justifyContent: 'center' }}>
        {Array.from({ length: total }).map((_, i) => (
          <View key={i} style={[pi.dot, {
            backgroundColor: i === current ? color : colors.surfaceHigher,
            width: i === current ? 16 : 6,
          }]} />
        ))}
      </View>
    );
  }
  return (
    <View style={{ flex: 1, paddingHorizontal: space.md }}>
      <View style={pi.track}>
        <LinearGradient
          colors={[color, color + 'AA']}
          style={[pi.fill, { width: `${((current + 1) / total) * 100}%` as any }]}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
        />
      </View>
    </View>
  );
}

function createReaderStyles(colors: ReturnType<typeof useColors>) { return StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgDeep },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md },
  loadingText: { ...T.body, color: colors.textSecondary },
  errorText: { ...T.h2, color: colors.text },
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.md, paddingVertical: space.sm,
  },
  topRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  iconCircle: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  pubChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: radius.full, borderWidth: 1,
    flexShrink: 1,
  },
  pubName: { ...T.badge, flexShrink: 1 },
  progressTrack: { height: 2, backgroundColor: colors.surfaceHigher, marginHorizontal: space.md },
  progressFill: { height: 2, borderRadius: 1 },
  articleHeader: { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm, gap: 4 },
  articleDate: { ...T.label, color: colors.accent, fontSize: 10 },
  articleTitle: {
    fontSize: 22, fontWeight: '800', color: colors.text,
    lineHeight: 30, letterSpacing: -0.3, marginBottom: space.sm,
  },
  readMeta: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4 },
  readMetaText: { ...T.caption, color: colors.textMuted },
  readMetaDot: { ...T.caption, color: colors.textMuted },
  divider: { height: 1, backgroundColor: colors.border, marginHorizontal: space.lg, marginBottom: 0 },
  page: { flex: 1, backgroundColor: colors.bgDeep },
  pageContent: { padding: space.lg, paddingBottom: 60 },
  bodyText: { fontSize: READER_FONT, lineHeight: READER_LINE, color: colors.text, fontFamily: 'System' },
  finishedBadge: { marginTop: space.xl, borderRadius: radius.lg, overflow: 'hidden' },
  finishedGrad: { padding: space.lg, alignItems: 'center', gap: space.sm },
  finishedText: { ...T.h3, color: colors.success },
  finishedSub: { ...T.caption, color: colors.textMuted },
  footer: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingVertical: space.sm,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  pageNum: { ...T.h3, color: colors.text, minWidth: 60 },
  pageTotal: { ...T.caption, color: colors.textMuted },
  modeBtn: {
    padding: 6, borderRadius: radius.md,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  highlightBar: {
    backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border,
    paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: space.md, gap: 10,
  },
  highlightBarLabel: { ...T.body, fontSize: 14, color: colors.textSecondary, fontStyle: 'italic', lineHeight: 20 },
  lookupPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.accentMuted, borderRadius: radius.full,
    paddingHorizontal: 16, paddingVertical: 9, borderWidth: 1, borderColor: colors.accentBorder,
  },
  lookupPillText: { ...T.body, fontSize: 14, color: colors.accent, fontWeight: '700' },
  highlightColors: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  highlightCta: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.accent, borderRadius: radius.full,
    paddingHorizontal: 16, paddingVertical: 9,
  },
  highlightCtaText: { ...T.body, fontSize: 14, fontWeight: '700', color: colors.bg },
  highlightDismiss: { marginLeft: 'auto' },
  scrollTopBtn: {
    position: 'absolute', bottom: 80, right: space.lg,
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 6,
    elevation: 8,
  },
  lookupSheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    height: LOOKUP_H, backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    borderWidth: 1, borderColor: colors.border,
    shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.3, shadowRadius: 12,
    elevation: 20,
  },
  lookupHandle: {
    width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border,
    alignSelf: 'center', marginTop: 10, marginBottom: 6,
  },
  lookupHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: space.md, paddingBottom: space.sm,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  lookupTitle: { ...T.caption, color: colors.text, fontStyle: 'italic', flex: 1 },
  hlBadge: {
    position: 'absolute', top: 2, right: 2,
    minWidth: 16, height: 16, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3,
  },
  hlBadgeText: { fontSize: 10, fontWeight: '800' },
  hlListSheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    borderWidth: 1, borderColor: colors.border,
    shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.3, shadowRadius: 12,
    elevation: 20,
  },
  hlListHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingVertical: space.md,
  },
  hlListTitle: { ...T.h2, color: colors.text },
  hlListEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 40, marginTop: 20 },
  hlListEmptyText: { ...T.h3, color: colors.text },
  hlListEmptySub: { ...T.caption, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
  hlItem: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: space.lg, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  hlAccent: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
  hlText: { ...T.body, fontSize: 14, lineHeight: 21, color: colors.text, flex: 1 },
  colorFilterRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: space.lg, paddingBottom: 10,
  },
  colorFilterDot: { width: 22, height: 22, borderRadius: 11 },
  hlSheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    borderWidth: 1, borderColor: colors.border,
    shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.3, shadowRadius: 12,
    elevation: 20,
  },
  hlSheetHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingBottom: space.sm,
  },
  hlSheetTitle: { ...T.h2, color: colors.text },
  hlSheetBody: { paddingHorizontal: space.lg, paddingBottom: space.md, gap: 16 },
  hlQuoteBubble: {
    padding: 14, borderRadius: radius.md, backgroundColor: colors.surfaceHigher,
    borderLeftWidth: 3,
  },
  hlQuoteText: { ...T.body, fontStyle: 'italic', fontSize: 15, lineHeight: 23, color: colors.textSecondary },
  hlColorRow: { flexDirection: 'row', gap: 14, paddingVertical: 4 },
  hlColorDot: { width: 28, height: 28, borderRadius: 14 },
  hlColorDotSelected: { borderWidth: 3, borderColor: colors.text, transform: [{ scale: 1.15 }] },
  hlNoteInput: {
    borderWidth: 1, borderRadius: radius.md, borderColor: colors.border,
    backgroundColor: colors.surfaceHigher, color: colors.text,
    padding: 12, minHeight: 90, ...T.body, fontSize: 14,
  },
  hlSheetActions: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: space.lg, paddingVertical: space.md,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  hlDeleteBtn: {
    width: 46, height: 46, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.border,
  },
  hlSaveBtn: { flex: 1, height: 46, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  hlSaveBtnText: { ...T.body, fontWeight: '700', color: '#090C15' },
}); }
