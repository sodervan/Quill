import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, PanResponder, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import * as FileSystem from 'expo-file-system/legacy';
import * as fflate from 'fflate';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../../../theme/ThemeContext';
import { type as T, space } from '../../../theme';
import type { BookHighlightRow } from '../../../data/books';


interface Chapter { id: string; title: string; html: string; }

export type ReadingTheme = 'default' | 'sepia' | 'night';

interface Props {
  fileUri: string;
  initialChapter: number;
  initialScrollOffset?: number;
  onChapterChanged: (chapter: number, total: number) => void;
  onScrollChanged?: (depth: number) => void;
  onTextSelected: (text: string, chapter: number) => void;
  onAddNote: (chapter: number) => void;
  highlights: BookHighlightRow[];
  rawMode?: boolean;
  readingTheme?: ReadingTheme;
}

// ─── EPUB parsing ─────────────────────────────────────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function decodeFile(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8').decode(bytes); } catch { return ''; }
}
function extractBodyHtml(html: string): string {
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return m ? m[1] : html;
}
function getChapterTitle(html: string, fallback: string): string {
  const h = html.match(/<(?:h1|h2|title)[^>]*>([^<]+)</i);
  return h ? h[1].trim() : fallback;
}

function resolveEpubPath(chapterDir: string, relative: string): string {
  const parts = chapterDir.split('/').filter(Boolean);
  for (const seg of relative.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function inlineImages(html: string, files: Record<string, Uint8Array>, chapterDir: string): string {
  return html.replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/gi, (match, pre, src, post) => {
    if (src.startsWith('data:') || src.startsWith('http')) return match;
    const resolved = resolveEpubPath(chapterDir, src.split('#')[0]);
    const key = Object.keys(files).find(
      (k) => k === resolved || k.toLowerCase() === resolved.toLowerCase(),
    );
    if (!key) return match;
    try {
      const bytes = files[key];
      const ext = (key.split('.').pop() ?? 'jpg').toLowerCase();
      const mimeMap: Record<string, string> = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp', svg: 'svg+xml' };
      const mime = `image/${mimeMap[ext] ?? 'jpeg'}`;
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return `${pre}data:${mime};base64,${btoa(bin)}${post}`;
    } catch { return match; }
  });
}

async function parseEpub(fileUri: string): Promise<Chapter[]> {
  const b64 = await FileSystem.readAsStringAsync(fileUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const bytes = base64ToBytes(b64);
  const files = fflate.unzipSync(bytes);

  const containerBytes = files['META-INF/container.xml'];
  if (!containerBytes) throw new Error('Not a valid EPUB: missing container.xml');
  const containerXml = decodeFile(containerBytes);
  const opfMatch = containerXml.match(/full-path="([^"]+)"/);
  if (!opfMatch) throw new Error('EPUB container.xml has no OPF path');
  const opfPath = opfMatch[1];

  const opfBytes = files[opfPath];
  if (!opfBytes) throw new Error('OPF file not found in EPUB');
  const opfXml = decodeFile(opfBytes);
  const opfDir = opfPath.includes('/') ? opfPath.split('/').slice(0, -1).join('/') + '/' : '';

  const manifestMap: Record<string, string> = {};
  for (const m of opfXml.matchAll(/<item\s[^>]*id="([^"]+)"[^>]*href="([^"]+)"/g))
    manifestMap[m[1]] = opfDir + m[2];
  for (const m of opfXml.matchAll(/<item\s[^>]*href="([^"]+)"[^>]*id="([^"]+)"/g))
    if (!manifestMap[m[2]]) manifestMap[m[2]] = opfDir + m[1];

  const spineIds: string[] = [];
  for (const m of opfXml.matchAll(/<itemref\s[^>]*idref="([^"]+)"/g)) spineIds.push(m[1]);

  const chapters: Chapter[] = [];
  const fileKeys = Object.keys(files);

  for (const id of spineIds) {
    const href = manifestMap[id];
    if (!href) continue;
    const cleanHref = href.split('#')[0];
    const key = fileKeys.find((k) => k === cleanHref || k.toLowerCase() === cleanHref.toLowerCase());
    if (!key) continue;
    const raw = decodeFile(files[key]);
    const chapterDir = key.includes('/') ? key.split('/').slice(0, -1).join('/') + '/' : '';
    const rawWithImages = inlineImages(raw, files, chapterDir);
    const title = getChapterTitle(raw, `Chapter ${chapters.length + 1}`);
    chapters.push({ id: String(chapters.length), title, html: rawWithImages });
  }

  return chapters.length > 0 ? chapters : [{ id: '0', title: 'Content', html: decodeFile(Object.values(files)[0]) }];
}

// ─── JS injection ──────────────────────────────────────────────────────────────
// Selection/hint JS runs once on page load via injectedJavaScript.
// Highlights are applied separately via injectJavaScript() so they work both
// on initial load (onLoadEnd) and when new highlights are added mid-session.

const SELECTION_JS = `
(function(){
  var cachedSel = '';
  var hint = document.createElement('div');
  hint.style.cssText = [
    'display:none','position:fixed','bottom:72px','left:50%',
    'transform:translateX(-50%)','background:rgba(0,0,0,0.82)',
    'color:#fff','padding:7px 16px','border-radius:20px',
    'font-size:12px','font-family:system-ui,-apple-system,sans-serif',
    'z-index:9999','pointer-events:none','white-space:nowrap',
    'box-shadow:0 2px 8px rgba(0,0,0,0.35)',
  ].join(';');
  hint.textContent = '\\u270E  Tap to highlight or look up';
  document.body.appendChild(hint);

  var selActive = false;
  document.addEventListener('selectionchange', function() {
    var sel = window.getSelection();
    var t = sel ? sel.toString().trim() : '';
    if (t.length > 2) {
      cachedSel = t;
      hint.style.display = 'block';
      if (!selActive) {
        selActive = true;
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'sel_active', v: true }));
      }
    } else {
      hint.style.display = 'none';
      if (selActive) {
        selActive = false;
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'sel_active', v: false }));
      }
    }
  });

  function sendSel() {
    var sel = window.getSelection ? window.getSelection() : null;
    var t = (sel ? sel.toString().trim() : '') || cachedSel;
    if (t.length > 2) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'selection', text: t }));
      hint.style.display = 'none';
      cachedSel = '';
    }
  }
  document.addEventListener('mouseup', sendSel);
  document.addEventListener('touchend', sendSel);

  // Throttled scroll depth reporting (0–1)
  var scrollTimer = null;
  window.addEventListener('scroll', function() {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(function() {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      if (max <= 0) return;
      var depth = Math.min(1, window.scrollY / max);
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'scroll_depth', depth: depth }));
    }, 400);
  }, { passive: true });
})();
true;`;

function buildApplyHighlightsJS(items: Array<{ id: string; text: string; color: string }>): string {
  const data = JSON.stringify(items);
  return `
(function(){
  function applyHL(id,txt,color){
    var walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    var node;
    while((node=walker.nextNode())){
      var v=node.nodeValue||'';
      var idx=v.indexOf(txt);
      if(idx<0)continue;
      var span=document.createElement('span');
      span.setAttribute('data-hl-id',id);
      span.style.cssText='background:'+color+'55;border-radius:2px;padding:0 1px;';
      var r=document.createRange();
      r.setStart(node,idx);
      r.setEnd(node,idx+txt.length);
      try{r.surroundContents(span);}catch(e){}
      break;
    }
  }
  var hs=${data};
  hs.forEach(function(h){try{applyHL(h.id,h.text,h.color);}catch(e){}});
})();true;`;
}

function buildRemoveHighlightsJS(ids: string[]): string {
  const data = JSON.stringify(ids);
  return `
(function(){
  var ids=${data};
  ids.forEach(function(id){
    var span=document.querySelector('[data-hl-id="'+id+'"]');
    if(!span)return;
    var p=span.parentNode;
    while(span.firstChild)p.insertBefore(span.firstChild,span);
    p.removeChild(span);
    p.normalize();
  });
})();true;`;
}

// ─── HTML builder ─────────────────────────────────────────────────────────────

const THEME_COLORS = {
  default: null, // resolved at runtime from app theme
  sepia:  { bg: '#F5EDD8', fg: '#2E1F0F', link: '#7A4B28', muted: '#9A7B5A' },
  night:  { bg: '#0E0E12', fg: '#C4BEB5', link: '#A8895C', muted: '#5A5868' },
};

function buildChapterHtml(
  chapter: Chapter,
  isDark: boolean,
  rawMode: boolean,
  readingTheme: ReadingTheme,
): string {
  const body = extractBodyHtml(chapter.html);

  const tc = readingTheme !== 'default' ? THEME_COLORS[readingTheme]! : null;
  const bg   = tc ? tc.bg   : (isDark ? '#0A0C16' : '#F5F4F0');
  const fg   = tc ? tc.fg   : (isDark ? '#EDE8E0' : '#1C1A17');
  const link = tc ? tc.link : (isDark ? '#C8AA6E' : '#A67C3D');
  const muted = tc ? tc.muted : (isDark ? '#505869' : '#9A9590');

  if (rawMode) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>
  html,body{margin:0;padding:0;background:${bg};}
  body{font-size:15px;line-height:1.65;color:${fg};padding:14px 14px 80px;word-break:break-word;}
  img{max-width:100%;height:auto;}a{color:${fg};}
</style>
</head><body>${body}</body></html>`;
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>
  *{box-sizing:border-box;-webkit-text-size-adjust:none;}
  html,body{margin:0;padding:0;background:${bg};}
  body{
    font-family:'Georgia','Times New Roman',serif;
    font-size:17px;line-height:1.75;color:${fg};
    padding:28px 22px 88px;word-break:break-word;
    text-align:left;
  }
  h1,h2,h3,h4{
    line-height:1.3;margin:32px 0 14px;
    text-align:center;font-family:'Georgia',serif;
  }
  h1{font-size:24px;letter-spacing:0.02em;}
  h2{font-size:20px;letter-spacing:0.01em;}
  h3{font-size:18px;}
  p{margin:0 0 16px;}
  /* first paragraph after a heading — left-aligned indent */
  h1+p,h2+p,h3+p{text-indent:0;}
  p+p{text-indent:1.5em;margin-top:0;}
  a{color:${link};text-decoration:none;}
  img{max-width:100%;height:auto;border-radius:6px;margin:10px auto;display:block;}
  blockquote{
    margin:18px 0;padding:12px 18px;
    border-left:3px solid ${link};color:${muted};font-style:italic;
    text-align:left;
  }
  code,pre{font-family:monospace;font-size:14px;background:rgba(128,128,128,0.12);border-radius:4px;padding:2px 5px;}
  pre{padding:12px;overflow-x:auto;text-align:left;}
  ::selection{background:${link}44;}
</style>
</head><body>${body}</body></html>`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function EpubReader({
  fileUri, initialChapter, initialScrollOffset = 0,
  onChapterChanged, onScrollChanged, onTextSelected,
  onAddNote, highlights, rawMode = false, readingTheme = 'default',
}: Props) {
  const colors = useColors();
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [current, setCurrent] = useState(initialChapter || 0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const currentRef = useRef(current);
  const chaptersLenRef = useRef(0);
  const isDark = colors.bg === '#090C15';

  const webViewRef = useRef<WebView>(null);
  const appliedHLRef = useRef<Set<string>>(new Set());
  const prevCurrentRef = useRef(current);
  // Only restore scroll offset on the very first load of initialChapter
  const scrollRestoredRef = useRef(false);

  function injectHighlights(items: BookHighlightRow[]) {
    if (!webViewRef.current || items.length === 0) return;
    webViewRef.current.injectJavaScript(
      buildApplyHighlightsJS(items.map((h) => ({ id: h.id, text: h.selected_text, color: h.color })))
    );
  }

  function handleLoadEnd() {
    appliedHLRef.current = new Set();
    const forChapter = highlights.filter((h) => h.page === current && h.selected_text);
    forChapter.forEach((h) => appliedHLRef.current.add(h.id));
    injectHighlights(forChapter);

    // Restore scroll position on first load of the initial chapter only
    if (!scrollRestoredRef.current && current === initialChapter && initialScrollOffset > 0.01) {
      scrollRestoredRef.current = true;
      webViewRef.current?.injectJavaScript(`
        (function(){
          var tries = 0;
          function restore() {
            var max = document.documentElement.scrollHeight - window.innerHeight;
            if (max > 10) {
              window.scrollTo(0, ${initialScrollOffset} * max);
            } else if (tries++ < 8) {
              setTimeout(restore, 80);
            }
          }
          setTimeout(restore, 120);
        })();true;
      `);
    }
  }

  // When highlights or chapter changes:
  //   - chapter change: reset tracking (handleLoadEnd will re-apply after load)
  //   - same chapter, new highlight: inject only the new ones immediately
  useEffect(() => {
    if (current !== prevCurrentRef.current) {
      prevCurrentRef.current = current;
      appliedHLRef.current = new Set();
      return;
    }
    const forChapter = highlights.filter((h) => h.page === current && h.selected_text);
    const currentIds = new Set(forChapter.map((h) => h.id));

    // Remove spans for deleted highlights
    const removedIds = [...appliedHLRef.current].filter((id) => !currentIds.has(id));
    if (removedIds.length > 0) {
      removedIds.forEach((id) => appliedHLRef.current.delete(id));
      webViewRef.current?.injectJavaScript(buildRemoveHighlightsJS(removedIds));
    }

    // Apply newly added highlights
    const newOnes = forChapter.filter((h) => !appliedHLRef.current.has(h.id));
    if (newOnes.length === 0) return;
    newOnes.forEach((h) => appliedHLRef.current.add(h.id));
    injectHighlights(newOnes);
  }, [highlights, current]);

  const goToFn = useRef<(idx: number) => void>(() => {});
  useEffect(() => {
    goToFn.current = (idx: number) => {
      if (idx < 0 || idx >= chaptersLenRef.current) return;
      setCurrent(idx);
      currentRef.current = idx;
      onChapterChanged(idx, chaptersLenRef.current);
    };
  });

  // Disabled while the WebView has an active text selection (sel_active message from SELECTION_JS).
  const isSelectingRef = useRef(false);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponder: (_, { dx, dy }) =>
        !isSelectingRef.current && Math.abs(dx) > 30 && Math.abs(dx) > Math.abs(dy) * 3,
      onShouldBlockNativeResponder: () => false,
      onPanResponderRelease: (_, { dx, vx }) => {
        if (dx < -50 || vx < -0.5) goToFn.current(currentRef.current + 1);
        else if (dx > 50 || vx > 0.5) goToFn.current(currentRef.current - 1);
      },
    })
  ).current;

  useEffect(() => {
    parseEpub(fileUri)
      .then((chs) => {
        setChapters(chs);
        chaptersLenRef.current = chs.length;
        const start = Math.min(initialChapter || 0, chs.length - 1);
        setCurrent(start);
        currentRef.current = start;
        onChapterChanged(start, chs.length);
      })
      .catch((e) => setError(e?.message ?? 'Failed to open EPUB'))
      .finally(() => setLoading(false));
  }, [fileUri]);

  function handleMessage(e: WebViewMessageEvent) {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.type === 'selection' && msg.text) {
        onTextSelected(msg.text, currentRef.current);
      } else if (msg.type === 'sel_active') {
        isSelectingRef.current = msg.v as boolean;
      } else if (msg.type === 'scroll_depth') {
        onScrollChanged?.(msg.depth as number);
      }
    } catch {}
  }

  const pageHasHighlight = highlights.some((h) => h.page === current);

  if (loading) {
    return (
      <View style={s.centered}>
        <ActivityIndicator color={colors.accent} size="large" />
        <Text style={[s.msg, { color: colors.textMuted }]}>Parsing EPUB…</Text>
      </View>
    );
  }

  if (error || chapters.length === 0) {
    return (
      <View style={s.centered}>
        <Ionicons name="alert-circle-outline" size={48} color={colors.textMuted} />
        <Text style={[s.msg, { color: colors.textMuted }]}>
          {error || 'No chapters found in this EPUB'}
        </Text>
        <Text style={[s.sub, { color: colors.textMuted }]}>Try re-importing the file.</Text>
      </View>
    );
  }

  const ch = chapters[current];
  const html = buildChapterHtml(ch, isDark, rawMode, readingTheme);

  // Background color for the WebView itself (shows in margins)
  const tc = readingTheme !== 'default' ? THEME_COLORS[readingTheme]! : null;
  const webBg = tc ? tc.bg : (isDark ? '#0A0C16' : '#F5F4F0');

  return (
    <View style={s.root} {...panResponder.panHandlers}>
      <WebView
        ref={webViewRef}
        source={{ html, baseUrl: '' }}
        style={[s.web, { backgroundColor: webBg }]}
        injectedJavaScript={SELECTION_JS}
        onLoadEnd={handleLoadEnd}
        onMessage={handleMessage}
        scrollEnabled
        showsVerticalScrollIndicator={false}
        overScrollMode="never"
        originWhitelist={['*']}
        javaScriptEnabled
      />

      {/* Chapter navigation bar */}
      <View style={[s.navBar, { backgroundColor: colors.surface + 'F2', borderTopColor: colors.border }]}>
        <TouchableOpacity
          style={[s.navArrow, current === 0 && s.disabled]}
          onPress={() => goToFn.current(current - 1)}
          disabled={current === 0}
        >
          <Ionicons name="chevron-back" size={20} color={current === 0 ? colors.textMuted : colors.text} />
        </TouchableOpacity>

        <Text style={[s.navLabel, { color: colors.textMuted }]} numberOfLines={1}>
          {current + 1} / {chapters.length}
          {ch.title && ch.title !== `Chapter ${current + 1}` ? `  ·  ${ch.title}` : ''}
        </Text>

        <TouchableOpacity
          style={[s.navArrow, current === chapters.length - 1 && s.disabled]}
          onPress={() => goToFn.current(current + 1)}
          disabled={current === chapters.length - 1}
        >
          <Ionicons name="chevron-forward" size={20} color={current === chapters.length - 1 ? colors.textMuted : colors.text} />
        </TouchableOpacity>
      </View>

      {/* Note FAB */}
      <View style={s.fab}>
        <TouchableOpacity
          style={[
            s.fabBtn,
            { backgroundColor: pageHasHighlight ? colors.accent : colors.surface,
              borderColor: colors.accentBorder },
          ]}
          onPress={() => onAddNote(current)}
          activeOpacity={0.85}
        >
          <Ionicons
            name={pageHasHighlight ? 'document-text' : 'document-text-outline'}
            size={20}
            color={pageHasHighlight ? colors.bg : colors.accent}
          />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  web: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 32 },
  msg: { ...T.body, textAlign: 'center' },
  sub: { ...T.caption, textAlign: 'center', lineHeight: 20 },
  navBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.md, paddingVertical: 10, borderTopWidth: 1,
  },
  navArrow: { padding: 8 },
  disabled: { opacity: 0.3 },
  navLabel: { ...T.caption, flex: 1, textAlign: 'center', marginHorizontal: 8 },
  fab: { position: 'absolute', bottom: 68, right: space.md },
  fabBtn: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, elevation: 5,
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
  },
});
