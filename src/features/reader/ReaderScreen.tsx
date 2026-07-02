import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Dimensions, ScrollView, StatusBar,
  StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import PagerView from 'react-native-pager-view';
import { WebView } from 'react-native-webview';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { format } from 'date-fns';

import { RootStackParamList } from '../../navigation';
import { colors, type as T, space, radius } from '../../theme';
import { FaviconAvatar } from '../../components/FaviconAvatar';
import { PUBLICATIONS } from '../../data/publications';
import {
  getArticleById, recordPageRead, updateArticleWordCount,
  logReadEvent, isArticleSaved, saveArticle, unsaveArticle,
  saveHighlight, getHighlightsForArticle, deleteHighlight, type HighlightRow,
  getRemoteMetaSync,
} from '../../data/db';
import { resolveArticleContent } from '../../data/extractor';

type Props = NativeStackScreenProps<RootStackParamList, 'Reader'>;

const { height: SCREEN_H, width: SCREEN_W } = Dimensions.get('window');
const READER_FONT = 18;
const READER_LINE = 30;

export default function ReaderScreen({ route, navigation }: Props) {
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

  const readStartRef = useRef<number>(Date.now());
  const scrollDepthRef = useRef(0);
  const webViewRef = useRef<any>(null);

  const pub = PUBLICATIONS.find((p) => p.id === publicationId);
  const remoteMeta = pub ? null : getRemoteMetaSync(publicationId);
  const c = pub?.color ?? remoteMeta?.color ?? colors.accent;
  const pubName = pub?.name ?? remoteMeta?.name ?? 'Source';
  const pubEmoji = pub?.emoji ?? '📰';
  const [articleLink, setArticleLink] = useState('');

  useEffect(() => {
    async function load() {
      const article = await getArticleById(articleId);
      if (!article) { setLoading(false); return; }

      setTitle(article.title);
      setArticleLink(article.link);
      setArticleUrl(article.link);
      if (article.pub_date > 0) setPubDate(new Date(article.pub_date));
      const [isSaved, existingHighlights] = await Promise.all([
        isArticleSaved(articleId),
        getHighlightsForArticle(articleId),
      ]);
      setSaved(isSaved);
      setHighlights(existingHighlights);
      if (article.content_html) setRawHtml(article.content_html);
      readStartRef.current = Date.now();

      const content = await resolveArticleContent(article.link, article.content_html ?? undefined);

      if (!content || content.pages.length === 0) {
        setUseWebView(true);
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
      ));
      setLoading(false);
    }
    void load();
  }, [articleId]);

  useEffect(() => {
    return () => {
      const seconds = Math.floor((Date.now() - readStartRef.current) / 1000);
      void logReadEvent(articleId, seconds, scrollDepthRef.current);
    };
  }, [articleId]);

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

  function onWebMessage(e: { nativeEvent: { data: string } }) {
    const raw = e.nativeEvent.data;
    try {
      const msg = JSON.parse(raw);
      // Only treat as a typed event if it's an object with a string type field
      if (msg && typeof msg === 'object' && typeof msg.type === 'string') {
        if (msg.type === 'text_selected') setSelectedText(msg.text ?? '');
        else if (msg.type === 'text_deselected') setSelectedText('');
        else if (msg.type === 'highlight_tap') handleDeleteHighlight(msg.id as number);
        return;
      }
    } catch {}
    // Plain float string = scroll depth
    const depth = parseFloat(raw);
    if (!isNaN(depth)) {
      scrollDepthRef.current = depth;
      setScrollProgress(depth);
    }
  }

  const readMins = wordCount ? Math.max(1, Math.round(wordCount / 200)) : null;
  const progress = scrollMode === 'scroll'
    ? scrollProgress
    : (pages.length > 0 ? (currentPage + 1) / pages.length : 0);

  if (loading) {
    return (
      <View style={[s.root, s.centered]}>
        <StatusBar barStyle="light-content" />
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={s.loadingText}>Loading article…</Text>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" />
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
            <Text style={[s.pubName, { color: c }]}>{pubName}</Text>
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
          <WebView source={{ uri: articleUrl }} style={{ flex: 1 }} />
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
            style={{ flex: 1, backgroundColor: colors.bgDeep }}
            injectedJavaScript={READER_JS}
            onMessage={onWebMessage}
            showsVerticalScrollIndicator={false}
            originWhitelist={['*']}
          />
        ) : (
          /* ── Horizontal page mode ── */
          <PagerView
            style={{ flex: 1 }}
            initialPage={0}
            onPageSelected={onPageSelected}
            orientation="horizontal"
          >
            {pages.map((text, i) => (
              <ScrollView
                key={i}
                style={s.page}
                contentContainerStyle={s.pageContent}
                nestedScrollEnabled
                showsVerticalScrollIndicator={false}
              >
                <Text style={s.bodyText}>{text}</Text>
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
            <Text style={s.highlightBarLabel} numberOfLines={1}>
              "{selectedText.slice(0, 40)}{selectedText.length > 40 ? '…' : ''}"
            </Text>
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
                    `(function(){var el=document.getElementById('__ql_pending');if(!el)return;var p=el.parentNode;if(p){while(el.firstChild)p.insertBefore(el.firstChild,el);p.removeChild(el);}})();true;`
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
    </View>
  );
}

const HIGHLIGHT_COLORS = [
  { color: '#C8AA6E', label: 'Gold' },
  { color: '#34D399', label: 'Green' },
  { color: '#A78BFA', label: 'Purple' },
  { color: '#F472B6', label: 'Pink' },
];

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

  // Text selection: capture range into a pending span so it survives the RN button tap.
  // Guard: don't wrap while the user is still touching (mid-drag), and don't react to the
  // selectionchange that our own removeAllRanges() fires (would un-wrap the pending span).
  var PENDING = '__ql_pending';
  function removePending() {
    var el = document.getElementById(PENDING);
    if (!el) return;
    var p = el.parentNode;
    if (p) { while (el.firstChild) p.insertBefore(el.firstChild, el); p.removeChild(el); }
  }

  var touching = false;
  var wrapping = false;
  var selTimeout;

  document.addEventListener('touchstart', function() {
    touching = true;
    clearTimeout(selTimeout);
  }, { passive: true });

  document.addEventListener('touchend', function() {
    touching = false;
    clearTimeout(selTimeout);
    selTimeout = setTimeout(commitSelection, 250);
  }, { passive: true });

  document.addEventListener('selectionchange', function() {
    if (touching || wrapping) return;
    clearTimeout(selTimeout);
    selTimeout = setTimeout(commitSelection, 300);
  });

  function commitSelection() {
    if (touching || wrapping) return;
    var sel = window.getSelection();
    var text = sel ? sel.toString().trim() : '';
    if (text.length > 2) {
      removePending();
      wrapping = true;
      try {
        var range = sel.getRangeAt(0);
        var span = document.createElement('span');
        span.id = PENDING;
        try { range.surroundContents(span); }
        catch(e) { var frag = range.extractContents(); span.appendChild(frag); range.insertNode(span); }
        sel.removeAllRanges();
        setTimeout(function() { wrapping = false; }, 0);
      } catch(e) {
        wrapping = false;
      }
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'text_selected', text: text }));
    } else if (!document.getElementById(PENDING)) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'text_deselected' }));
    }
  }

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
  var span=document.getElementById('__ql_pending');
  if(span){
    var mark=makeMark();
    while(span.firstChild)mark.appendChild(span.firstChild);
    span.parentNode.replaceChild(mark,span);
    window.getSelection().removeAllRanges();
    return;
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

function buildStyledHtml(content: string, title: string, isHtml = false, highlights: HighlightRow[] = []): string {
  const rawBody = isHtml ? content : content.split('\n\n').map((p) => `<p>${p}</p>`).join('');
  const body = highlights.length > 0 ? applyHighlightsToHtml(rawBody, highlights) : rawBody;
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #090C15; color: #EDE8E0; font-family: -apple-system, system-ui, sans-serif;
    font-size: 18px; line-height: 1.7; padding: 20px 20px 80px; }
  h1,h2,h3,h4 { color: #EDE8E0; margin: 1.4em 0 0.6em; font-weight: 700; line-height: 1.3; }
  p { margin-bottom: 1.2em; }
  img { max-width: 100%; border-radius: 10px; display: block; margin: 1.2em 0; }
  a { color: #C8AA6E; text-decoration: none; }
  blockquote { border-left: 3px solid #C8AA6E; padding: 8px 16px; margin: 1.2em 0;
    color: #8E96A9; font-style: italic; background: #0E1525; border-radius: 0 8px 8px 0; }
  pre, code { background: #131C2E; padding: 4px 8px; border-radius: 6px;
    font-size: 14px; font-family: monospace; overflow-x: auto; }
  pre { padding: 12px 16px; display: block; margin: 1em 0; }
  ul, ol { padding-left: 1.5em; margin-bottom: 1.2em; }
  li { margin-bottom: 0.4em; }
  figure { margin: 1.2em 0; }
  figcaption { font-size: 13px; color: #505869; text-align: center; margin-top: 6px; }
  hr { border: none; border-top: 1px solid #1A2540; margin: 2em 0; }
  mark { border-radius: 3px; padding: 0 2px; }
  .finished { text-align:center; padding: 40px 20px; color: #34D399; font-size: 15px; }
</style></head><body>${body}
<div class="finished">✓ End of article</div>
</body></html>`;
}

function PageIndicator({ total, current, color }: { total: number; current: number; color: string }) {
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

const pi = StyleSheet.create({
  dot: { height: 6, borderRadius: 3 },
  track: { height: 4, backgroundColor: colors.surfaceHigher, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
});

const s = StyleSheet.create({
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
  },
  pubEmoji: { fontSize: 13 },
  pubName: { ...T.badge },
  progressTrack: { height: 2, backgroundColor: colors.surfaceHigher, overflow: 'hidden' },
  progressFill: { height: 2 },
  articleHeader: { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.md },
  articleDate: { ...T.label, color: colors.textMuted, marginBottom: space.sm },
  articleTitle: {
    fontSize: 22, fontWeight: '800', color: colors.text,
    lineHeight: 30, letterSpacing: -0.3, marginBottom: space.sm,
  },
  readMeta: { flexDirection: 'row', alignItems: 'center', gap: space.xs, flexWrap: 'wrap' },
  readMetaText: { ...T.caption, color: colors.textMuted },
  readMetaDot: { ...T.caption, color: colors.textMuted },
  divider: { height: 1, backgroundColor: colors.border },
  page: { flex: 1 },
  pageContent: {
    paddingHorizontal: space.lg, paddingVertical: space.lg,
    minHeight: SCREEN_H - 300,
  },
  bodyText: {
    fontSize: READER_FONT, lineHeight: READER_LINE,
    color: colors.text, letterSpacing: 0.15,
  },
  finishedBadge: { marginTop: space.xxl, borderRadius: radius.lg, overflow: 'hidden' },
  finishedGrad: {
    alignItems: 'center', paddingVertical: space.xl,
    gap: space.sm, borderRadius: radius.lg,
  },
  finishedText: { ...T.h2, color: colors.success },
  finishedSub: { ...T.caption, color: colors.textMuted },
  footer: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.md, paddingVertical: 10,
    borderTopWidth: 1, borderTopColor: colors.border, minHeight: 48,
  },
  pageNum: { ...T.h3, color: colors.textMuted, minWidth: 50 },
  pageTotal: { fontWeight: '400', color: colors.textMuted },
  modeBtn: {
    height: 32, borderRadius: 16, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 8,
  },

  // Highlight toolbar — flex sibling of WebView (not absolute) to avoid Android SurfaceView touch interception
  highlightBar: {
    backgroundColor: colors.surface,
    borderTopWidth: 1, borderTopColor: colors.borderStrong,
    paddingHorizontal: space.md, paddingVertical: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  highlightBarLabel: {
    ...T.caption, color: colors.textSecondary, flex: 1, marginRight: 12, fontStyle: 'italic',
  },
  highlightColors: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  highlightDot: { width: 26, height: 26, borderRadius: 13 },
  highlightDismiss: {
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: colors.surfaceHigher, alignItems: 'center', justifyContent: 'center',
  },
});
