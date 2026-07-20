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
  bookId: string;
  initialChapter: number;
  initialScrollOffset?: number;
  /** When set, scrolls to this highlight's mark once its chapter loads, taking priority
   *  over initialScrollOffset. Falls back to the normal offset if the mark isn't found. */
  scrollToHighlightId?: string | null;
  onChapterChanged: (chapter: number, total: number) => void;
  onScrollChanged?: (depth: number) => void;
  onTextSelected: (text: string, chapter: number) => void;
  onAddNote: (chapter: number) => void;
  onHighlightTap?: (id: string) => void;
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

// Parsing a multi-MB EPUB means unzipping the whole archive and re-inlining every
// embedded image as base64 for every chapter — expensive, and was being redone from
// scratch on every single open. Cache the parsed output to disk, keyed by book id and
// invalidated by the source file's mtime/size, so repeat opens just read a JSON blob.
const CACHE_DIR = `${FileSystem.documentDirectory}books/parsed/`;

function cachePathFor(bookId: string): string {
  return `${CACHE_DIR}${bookId}.json`;
}

async function readCachedChapters(bookId: string, mtime: number, size: number): Promise<Chapter[] | null> {
  try {
    const path = cachePathFor(bookId);
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(path);
    const cached = JSON.parse(raw) as { mtime: number; size: number; chapters: Chapter[] };
    if (cached.mtime !== mtime || cached.size !== size) return null;
    return cached.chapters;
  } catch { return null; }
}

async function writeCachedChapters(bookId: string, mtime: number, size: number, chapters: Chapter[]): Promise<void> {
  try {
    await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
    await FileSystem.writeAsStringAsync(cachePathFor(bookId), JSON.stringify({ mtime, size, chapters }));
  } catch {}
}

async function parseEpub(fileUri: string, bookId: string): Promise<Chapter[]> {
  const fileInfo = await FileSystem.getInfoAsync(fileUri, { size: true } as any);
  const mtime = (fileInfo as any).modificationTime ?? 0;
  const size = (fileInfo as any).size ?? 0;

  const cached = await readCachedChapters(bookId, mtime, size);
  if (cached) return cached;

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

  const result = chapters.length > 0 ? chapters : [{ id: '0', title: 'Content', html: decodeFile(Object.values(files)[0]) }];
  void writeCachedChapters(bookId, mtime, size, result);
  return result;
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

  // Tap on an existing highlight (not part of ending a text selection) → open its edit sheet
  document.addEventListener('click', function(e) {
    if (selActive) return;
    var el = e.target;
    while (el && el !== document.body && !(el.hasAttribute && el.hasAttribute('data-hl-id'))) el = el.parentElement;
    if (el && el.hasAttribute && el.hasAttribute('data-hl-id')) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'highlight_tap', id: el.getAttribute('data-hl-id') }));
    }
  });

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
  // A highlight spanning a paragraph/list-item break can't be found as one literal
  // string in a single text node (that's how Selection.toString() joined it, but the
  // DOM still has the real <p>/<li> boundary in between). Build a flat text index of
  // the whole body mapping each character back to its (node, offset), search each
  // newline-delimited chunk in that flat text, then reconstruct a real Range from the
  // match and wrap it per intersecting text node — same approach used for articles.
  function buildTextIndex(){
    var walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    var node,text='',map=[];
    while((node=walker.nextNode())){
      if(node.parentNode&&node.parentNode.hasAttribute&&node.parentNode.hasAttribute('data-hl-id'))continue;
      var v=node.nodeValue||'';
      for(var i=0;i<v.length;i++)map.push({node:node,offset:i});
      text+=v;
    }
    return {text:text,map:map};
  }
  function findChunkRange(index,chunk){
    var idx=index.text.indexOf(chunk);
    if(idx<0)return null;
    var startInfo=index.map[idx],endInfo=index.map[idx+chunk.length-1];
    if(!startInfo||!endInfo)return null;
    var r=document.createRange();
    r.setStart(startInfo.node,startInfo.offset);
    r.setEnd(endInfo.node,endInfo.offset+1);
    return r;
  }
  function wrapRange(range,id,color){
    var root=range.commonAncestorContainer;
    var entries=[];
    if(root.nodeType===3){
      entries.push({node:root,start:range.startOffset,end:range.endOffset});
    }else{
      var tw=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
      var n;
      while((n=tw.nextNode())){
        if(!n.nodeValue||!range.intersectsNode(n))continue;
        if(n.parentNode&&n.parentNode.hasAttribute&&n.parentNode.hasAttribute('data-hl-id'))continue;
        var st=(n===range.startContainer)?range.startOffset:0;
        var en=(n===range.endContainer)?range.endOffset:n.nodeValue.length;
        if(en>st)entries.push({node:n,start:st,end:en});
      }
    }
    entries.forEach(function(e){
      var sub=document.createRange();
      sub.setStart(e.node,e.start);
      sub.setEnd(e.node,e.end);
      var span=document.createElement('span');
      span.setAttribute('data-hl-id',id);
      span.style.cssText='background:'+color+'55;border-radius:2px;padding:0 1px;';
      try{sub.surroundContents(span);}catch(err){}
    });
  }
  function applyHL(id,txt,color){
    var chunks=txt.split(/\\r?\\n+/).map(function(c){return c.trim();}).filter(Boolean);
    chunks.forEach(function(chunk){
      var index=buildTextIndex();
      var range=findChunkRange(index,chunk);
      if(range)wrapRange(range,id,color);
    });
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
    // A highlight spanning a paragraph/list-item break wraps each intersecting text
    // node in its OWN span sharing this data-hl-id — remove all of them, not just one.
    var spans=document.querySelectorAll('[data-hl-id="'+id+'"]');
    spans.forEach(function(span){
      var p=span.parentNode;
      if(!p)return;
      while(span.firstChild)p.insertBefore(span.firstChild,span);
      p.removeChild(span);
      p.normalize();
    });
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
  fileUri, bookId, initialChapter, initialScrollOffset = 0, scrollToHighlightId,
  onChapterChanged, onScrollChanged, onTextSelected,
  onAddNote, onHighlightTap, highlights, rawMode = false, readingTheme = 'default',
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
  // Only restore the persisted offset on the very first load of initialChapter
  const scrollRestoredRef = useRef(false);
  // Tracks which chapter's HTML the WebView last actually loaded — lets handleLoadEnd
  // tell a genuine chapter change (start at top) apart from a same-chapter reload
  // (theme/rawMode toggle — the WebView's `source` changed, forcing a full reload,
  // but the reader hasn't actually moved, so it should stay exactly where it was).
  const loadedChapterRef = useRef<number | null>(null);
  // Continuously-updated scroll depth for the CURRENT chapter, used to restore
  // position across a same-chapter reload (theme/rawMode) — unlike the one-shot
  // initialScrollOffset prop, this always reflects where the reader actually is now.
  const liveScrollDepthRef = useRef(initialScrollOffset);
  // Only try to locate a given highlight once per navigation to it
  const highlightScrollDoneRef = useRef(false);
  // Which chapter handleLoadEnd should scroll-to-highlight on arrival at — seeded from
  // the mount-time target, updated whenever scrollToHighlightId changes at runtime
  // (e.g. the reader's own highlights list is used to jump to a different highlight).
  const pendingHLPageRef = useRef<number | null>(scrollToHighlightId != null ? (initialChapter || 0) : null);
  const mountHLIdRef = useRef(scrollToHighlightId);
  // Color actually rendered in the DOM for each applied id — lets the sync effect notice
  // an in-place color edit (same id, so the add/remove-by-id diff alone won't catch it).
  const appliedColorRef = useRef<Map<string, string>>(new Map());

  function injectHighlights(items: BookHighlightRow[]) {
    if (!webViewRef.current || items.length === 0) return;
    items.forEach((h) => appliedColorRef.current.set(h.id, h.color));
    webViewRef.current.injectJavaScript(
      buildApplyHighlightsJS(items.map((h) => ({ id: h.id, text: h.selected_text, color: h.color })))
    );
  }

  function restoreScroll(offset: number) {
    webViewRef.current?.injectJavaScript(`
      (function(){
        var tries = 0;
        function restore() {
          var max = document.documentElement.scrollHeight - window.innerHeight;
          if (max > 10) {
            window.scrollTo(0, ${offset} * max);
          } else if (tries++ < 8) {
            setTimeout(restore, 80);
          }
        }
        setTimeout(restore, 120);
      })();true;
    `);
  }

  function scrollToHighlightMark(id: string, fallbackOffset: number) {
    webViewRef.current?.injectJavaScript(`
      (function(){
        var tries = 0;
        function go() {
          var el = document.querySelector('[data-hl-id="${id}"]');
          if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
          if (tries++ < 20) { setTimeout(go, 120); return; }
          if (${fallbackOffset} > 0.01) {
            var max = document.documentElement.scrollHeight - window.innerHeight;
            if (max > 10) window.scrollTo(0, ${fallbackOffset} * max);
          }
        }
        setTimeout(go, 250);
      })();true;
    `);
  }

  function handleLoadEnd() {
    const isChapterChange = loadedChapterRef.current !== current;
    loadedChapterRef.current = current;

    appliedHLRef.current = new Set();
    appliedColorRef.current = new Map();
    const forChapter = highlights.filter((h) => h.page === current && h.selected_text);
    forChapter.forEach((h) => appliedHLRef.current.add(h.id));
    injectHighlights(forChapter);

    // Arriving at a specific highlight (from the Highlights page or the in-reader
    // highlights list) takes priority over any scroll-position restore.
    if (scrollToHighlightId && !highlightScrollDoneRef.current && current === pendingHLPageRef.current) {
      highlightScrollDoneRef.current = true;
      scrollToHighlightMark(scrollToHighlightId, initialScrollOffset);
      return;
    }

    if (isChapterChange) {
      // Genuine chapter navigation (or first load) — restore the persisted position
      // only if this is the chapter we originally opened to; otherwise start at top.
      if (!scrollRestoredRef.current && current === initialChapter && initialScrollOffset > 0.01) {
        scrollRestoredRef.current = true;
        restoreScroll(initialScrollOffset);
      }
      liveScrollDepthRef.current = current === initialChapter ? initialScrollOffset : 0;
    } else if (liveScrollDepthRef.current > 0.01) {
      // Same chapter reloaded (theme/rawMode toggle changed the WebView's source) —
      // put the reader back exactly where they were, not at the top.
      restoreScroll(liveScrollDepthRef.current);
    }
  }

  // When highlights or chapter changes:
  //   - chapter change: reset tracking (handleLoadEnd will re-apply after load)
  //   - same chapter, new highlight: inject only the new ones immediately
  useEffect(() => {
    if (current !== prevCurrentRef.current) {
      prevCurrentRef.current = current;
      appliedHLRef.current = new Set();
      appliedColorRef.current = new Map();
      return;
    }
    const forChapter = highlights.filter((h) => h.page === current && h.selected_text);
    const currentIds = new Set(forChapter.map((h) => h.id));

    // Remove spans for deleted highlights
    const removedIds = [...appliedHLRef.current].filter((id) => !currentIds.has(id));
    if (removedIds.length > 0) {
      removedIds.forEach((id) => { appliedHLRef.current.delete(id); appliedColorRef.current.delete(id); });
      webViewRef.current?.injectJavaScript(buildRemoveHighlightsJS(removedIds));
    }

    // Highlights whose color changed since they were injected (same id, so the
    // add/remove diff above never notices) — clear the old span(s) then re-inject.
    const changedOnes = forChapter.filter(
      (h) => appliedHLRef.current.has(h.id) && appliedColorRef.current.get(h.id) !== h.color,
    );
    if (changedOnes.length > 0) {
      webViewRef.current?.injectJavaScript(buildRemoveHighlightsJS(changedOnes.map((h) => h.id)));
    }

    // Apply newly added highlights, plus re-apply changed ones
    const toInject = forChapter.filter((h) => !appliedHLRef.current.has(h.id) || changedOnes.includes(h));
    if (toInject.length === 0) return;
    toInject.forEach((h) => appliedHLRef.current.add(h.id));
    injectHighlights(toInject);
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

  // Locate a highlight requested at runtime (e.g. tapped from the reader's own
  // highlights list while already reading) — distinct from the mount-time arrival,
  // which handleLoadEnd already handles via pendingHLPageRef's initial value.
  useEffect(() => {
    if (scrollToHighlightId === mountHLIdRef.current) return;
    mountHLIdRef.current = scrollToHighlightId;
    if (!scrollToHighlightId || chaptersLenRef.current === 0) return;
    const target = highlights.find((h) => h.id === scrollToHighlightId);
    if (!target) return;
    highlightScrollDoneRef.current = false;
    pendingHLPageRef.current = target.page;
    if (target.page === currentRef.current) {
      highlightScrollDoneRef.current = true;
      scrollToHighlightMark(scrollToHighlightId, 0);
    } else {
      goToFn.current(target.page);
    }
  }, [scrollToHighlightId, highlights]);

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
    parseEpub(fileUri, bookId)
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
        liveScrollDepthRef.current = msg.depth as number;
        onScrollChanged?.(msg.depth as number);
      } else if (msg.type === 'highlight_tap' && msg.id) {
        onHighlightTap?.(msg.id as string);
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
