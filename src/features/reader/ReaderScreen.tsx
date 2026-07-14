import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Animated, Dimensions, Linking, ScrollView, StatusBar,
  StyleSheet, Text, TouchableOpacity, TouchableWithoutFeedback, View,
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
  saveHighlight, getHighlightsForArticle, deleteHighlight, type HighlightRow,
  getRemoteMetaSync, getProgress,
} from '../../data/db';
import { resolveArticleContent } from '../../data/extractor';

type Props = NativeStackScreenProps<RootStackParamList, 'Reader'>;

const { height: SCREEN_H, width: SCREEN_W } = Dimensions.get('window');
const LOOKUP_H = Math.min(Math.round(SCREEN_H * 0.85), 700);
const READER_FONT = 18;
const READER_LINE = 30;

export default function ReaderScreen({ route, navigation }: Props) {
  const colors = useColors();
  const { isDark } = useTheme();
  const s = useMemo(() => createReaderStyles(colors), [colors]);
  const { articleId, publicationId } = route.params;

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
            scraped.pages.join('\n\n'),
            article.title,
            false,
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
            article.content_html ?? content.pages.join('\n\n'),
            article.title,
            !!article.content_html,
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

  async function handleHighlight(color: string) {
    const text = selectedText.trim();
    if (!text) return;
    setSelectedText('');
    const newId = await saveHighlight(articleId, text, color);
    setHighlights((prev) => [...prev, { id: newId, article_id: articleId, selected_text: text, color, created_at: Date.now() }]);
    // Inject mark directly into live DOM — no WebView reload, no scroll-to-top
    webViewRef.current?.injectJavaScript(buildInjectMarkJS(text, newId, color));
  }

  function handleDeleteHighlight(id: number) {
    Alert.alert('Remove highlight?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: async () => {
          await deleteHighlight(id);
          setHighlights((prev) => prev.filter((h) => h.id !== id));
          webViewRef.current?.injectJavaScript(
            `(function(){var m=document.querySelector('mark[data-highlight-id="${id}"]');if(m){var f=document.createDocumentFragment();while(m.firstChild)f.appendChild(m.firstChild);m.parentNode.replaceChild(f,m);}})();true;`
          );
        },
      },
    ]);
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

  function onWebViewLoadEnd() {
    const depth = restoreDepthRef.current;
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
        else if (msg.type === 'highlight_tap') handleDeleteHighlight(msg.id as number);
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

        {/* ── Highlight toolbar ── rendered as flex sibling so RN touches aren't swallowed by WebView ── */}
        {scrollMode === 'scroll' && !useWebView && selectedText.length > 0 && (
          <View style={s.highlightBar}>
            <View style={s.highlightTop}>
              <Text style={s.highlightBarLabel} numberOfLines={1}>
                "{selectedText.slice(0, 40)}{selectedText.length > 40 ? '…' : ''}"
              </Text>
              <TouchableOpacity onPress={() => openLookup(selectedText)} style={s.lookupPill} hitSlop={8}>
                <Ionicons name="search-outline" size={13} color={colors.accent} />
                <Text style={s.lookupPillText}>Look up</Text>
              </TouchableOpacity>
            </View>
            <View style={s.highlightColors}>
              {HIGHLIGHT_COLORS.map((hc) => (
                <TouchableOpacity
                  key={hc.color}
                  style={[s.highlightDot, { backgroundColor: hc.color }]}
                  onPress={() => void handleHighlight(hc.color)}
                  hitSlop={8}
                />
              ))}
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
  // Primary: convert the pending span captured at selection time
  // Primary: use the range saved at selection time (survives focus transfer to RN)
  var range=window.__savedRange;
  if(range){
    window.__savedRange=null;
    try{
      var mark=makeMark();
      try{range.surroundContents(mark);}
      catch(e){var frag=range.extractContents();mark.appendChild(frag);range.insertNode(mark);}
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
    const escaped = h.selected_text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      result = result.replace(
        new RegExp(escaped, 'g'),
        `<mark data-highlight-id="${h.id}" style="background:${h.color}55;border-radius:3px;padding:0 2px;cursor:pointer">${h.selected_text}</mark>`,
      );
    } catch {}
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
    paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: radius.full, borderWidth: 1, maxWidth: 160,
  },
  pubName: { ...T.badge, fontSize: 13, fontWeight: '600', flexShrink: 1 },
  progressTrack: { height: 2, backgroundColor: colors.surfaceHigher, marginHorizontal: space.md },
  progressFill: { height: 2, borderRadius: 1 },
  articleHeader: { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm, gap: 4 },
  articleDate: { ...T.label, color: colors.accent, fontSize: 10 },
  articleTitle: { ...T.d3, color: colors.text, lineHeight: 30 },
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
  highlightTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  highlightBarLabel: { ...T.caption, color: colors.textSecondary, fontStyle: 'italic', flex: 1, marginRight: 8 },
  lookupPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: colors.accentMuted, borderRadius: radius.full,
    paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: colors.accentBorder,
  },
  lookupPillText: { ...T.caption, color: colors.accent, fontWeight: '700' },
  highlightColors: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  highlightDot: { width: 28, height: 28, borderRadius: 14 },
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
}); }
