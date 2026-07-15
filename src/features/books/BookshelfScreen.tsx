import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Animated, Dimensions, Image, Modal, StyleSheet, Text,
  TouchableOpacity, TouchableWithoutFeedback, View, FlatList,
  StatusBar, ActivityIndicator,
} from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';

import { type as T, space, radius } from '../../theme';
import { useColors } from '../../theme/ThemeContext';
import {
  getAllBooks, upsertBook, getBookById, deleteBook, updateBookCover,
  stableBookId,
  type BookRow, type BookFormat,
} from '../../data/books';
import { RootStackParamList } from '../../navigation';
import { syncBook } from '../../lib/sync';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const COLS = 3;
const COL_GAP = 8;
const CARD_W = (SCREEN_W - space.md * 2 - COL_GAP * (COLS - 1)) / COLS;
const COVER_H = CARD_W * 1.52;
const SHEET_H = Math.min(420, SCREEN_H * 0.55);
const PICKER_H = SCREEN_H;          // full-screen, like Moon+

const COVER_PALETTES: [string, string][] = [
  ['#1E3A5F', '#2D6A9F'], ['#3D1A1A', '#8B3A3A'], ['#1A3D2B', '#2E7D52'],
  ['#2D1A4A', '#6B3FA0'], ['#3A2D10', '#9A7A30'], ['#1A2D3A', '#2E6A8B'],
  ['#3A1A2D', '#8B3A6B'], ['#1A3A3A', '#2E8B8B'],
];

function coverGradient(id: string): [string, string] {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h) ^ id.charCodeAt(i);
  return COVER_PALETTES[(h >>> 0) % COVER_PALETTES.length];
}
function progressPercent(b: BookRow) {
  if (!b.total_pages) return 0;
  return Math.min(100, Math.round((b.current_page / b.total_pages) * 100));
}
function titleFromFilename(name: string) {
  return name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ').trim();
}
function imageSearchUrl(title: string) {
  const q = encodeURIComponent(title.trim() + ' book cover');
  return `https://www.google.com/search?q=${q}&tbm=isch&hl=en`;
}

async function downloadCover(url: string, bookId: string): Promise<string | null> {
  try {
    const dir = (FileSystem.documentDirectory ?? '') + 'books/covers/';
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    const dest = dir + bookId + '_cover.jpg';
    const result = await FileSystem.downloadAsync(url, dest);
    return result.status === 200 ? result.uri : null;
  } catch { return null; }
}

// Silently grab the first API result for auto-cover on import
async function fetchFirstCoverUrl(title: string): Promise<string | null> {
  try {
    const q = encodeURIComponent(title.slice(0, 80));
    const res = await fetch(`https://openlibrary.org/search.json?q=${q}&limit=5`);
    if (!res.ok) return null;
    const json = await res.json();
    const doc = (json.docs ?? []).find((d: any) => d.cover_i);
    if (doc?.cover_i) return `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;
  } catch {}
  try {
    const q = encodeURIComponent(title.slice(0, 80));
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=3`);
    if (!res.ok) return null;
    const json = await res.json();
    const item = (json.items ?? []).find((i: any) => i.volumeInfo?.imageLinks?.thumbnail);
    if (item?.volumeInfo?.imageLinks?.thumbnail) {
      return (item.volumeInfo.imageLinks.thumbnail as string)
        .replace('http://', 'https://').replace('zoom=1', 'zoom=2');
    }
  } catch {}
  return null;
}

// Injected into the Google Images WebView — long-press any image to select it
const COVER_PICKER_JS = `
(function () {
  var timer = null;
  var highlighted = null;

  function findImg(el) {
    var cur = el;
    for (var i = 0; i < 6 && cur && cur !== document.body; i++) {
      if (cur.tagName === 'IMG') return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function bestUrl(img) {
    return img.getAttribute('data-iurl')
      || img.getAttribute('data-src')
      || (img.src && img.src.indexOf('data:') !== 0 ? img.src : null);
  }

  document.addEventListener('touchstart', function (e) {
    var touch = e.touches[0];
    var x = touch.clientX, y = touch.clientY;
    timer = setTimeout(function () {
      var el = document.elementFromPoint(x, y);
      if (!el) return;
      var img = findImg(el);
      if (!img) return;
      var url = bestUrl(img);
      if (!url) return;
      if (highlighted) highlighted.style.outline = '';
      highlighted = img;
      img.style.outline = '3px solid #C8AA6E';
      img.style.outlineOffset = '2px';
      try { window.navigator.vibrate(40); } catch (err) {}
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'imageSelected', url: url }));
    }, 500);
  }, { passive: true });

  document.addEventListener('touchend',  function () { clearTimeout(timer); });
  document.addEventListener('touchmove', function () { clearTimeout(timer); });
  true;
})();
`;

const WEBVIEW_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

export default function BookshelfScreen() {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const nav = useNavigation<Nav>();
  const [books, setBooks] = useState<BookRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);

  // ── Options sheet ──
  const [selectedBook, setSelectedBook] = useState<BookRow | null>(null);
  const [sheetMounted, setSheetMounted] = useState(false);
  const sheetAnimY = useRef(new Animated.Value(SHEET_H)).current;
  const sheetAnimBg = useRef(new Animated.Value(0)).current;

  // ── Cover picker (WebView) ──
  const [pickerBook, setPickerBook] = useState<BookRow | null>(null);
  const [pickerMounted, setPickerMounted] = useState(false);
  const [pickerSelectedUrl, setPickerSelectedUrl] = useState<string | null>(null);
  const [pickerApplying, setPickerApplying] = useState(false);
  const [webViewLoading, setWebViewLoading] = useState(true);
  const pickerAnimY = useRef(new Animated.Value(PICKER_H)).current;
  const pickerAnimBg = useRef(new Animated.Value(0)).current;

  useFocusEffect(useCallback(() => {
    let active = true;
    getAllBooks().then((rows) => { if (active) { setBooks(rows); setLoading(false); } });
    return () => { active = false; };
  }, []));

  // ── Options sheet ──
  function openSheet(book: BookRow) {
    setSelectedBook(book);
    setSheetMounted(true);
    sheetAnimY.setValue(SHEET_H);
    sheetAnimBg.setValue(0);
    Animated.parallel([
      Animated.spring(sheetAnimY, { toValue: 0, tension: 80, friction: 13, useNativeDriver: true }),
      Animated.timing(sheetAnimBg, { toValue: 1, duration: 220, useNativeDriver: true }),
    ]).start();
  }
  function closeSheet(cb?: () => void) {
    Animated.parallel([
      Animated.timing(sheetAnimY, { toValue: SHEET_H, duration: 260, useNativeDriver: true }),
      Animated.timing(sheetAnimBg, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start(() => { setSheetMounted(false); setSelectedBook(null); cb?.(); });
  }

  // ── Cover picker ──
  function openPicker(book: BookRow) {
    setPickerBook(book);
    setPickerSelectedUrl(null);
    setWebViewLoading(true);
    setPickerMounted(true);
    pickerAnimY.setValue(PICKER_H);
    pickerAnimBg.setValue(0);
    Animated.parallel([
      Animated.spring(pickerAnimY, { toValue: 0, tension: 72, friction: 14, useNativeDriver: true }),
      Animated.timing(pickerAnimBg, { toValue: 1, duration: 220, useNativeDriver: true }),
    ]).start();
  }
  function closePicker(cb?: () => void) {
    Animated.parallel([
      Animated.timing(pickerAnimY, { toValue: PICKER_H, duration: 260, useNativeDriver: true }),
      Animated.timing(pickerAnimBg, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start(() => { setPickerMounted(false); setPickerBook(null); setPickerSelectedUrl(null); cb?.(); });
  }

  function handleWebViewMessage(e: WebViewMessageEvent) {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.type === 'imageSelected' && msg.url) {
        setPickerSelectedUrl(msg.url);
      }
    } catch {}
  }

  async function handleApplyCover() {
    if (!pickerSelectedUrl || !pickerBook || pickerApplying) return;
    setPickerApplying(true);
    const coverUrl = pickerSelectedUrl;
    const uri = await downloadCover(coverUrl, pickerBook.id);
    setPickerApplying(false);
    if (uri) {
      await updateBookCover(pickerBook.id, uri);
      const bookId = pickerBook.id;
      const updatedBook = books.find((b) => b.id === bookId);
      if (updatedBook) syncBook(updatedBook, coverUrl).catch(() => {});
      // Append cache-buster so Image doesn't serve the stale cached version
      const bustUri = uri + '?v=' + Date.now();
      setBooks((prev) => prev.map((b) => b.id === bookId ? { ...b, cover_uri: bustUri } : b));
      closePicker();
    }
  }

  // ── Import ──
  async function handleImport() {
    if (importing) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'application/epub+zip', 'text/plain', 'text/x-markdown'],
        copyToCacheDirectory: false,
      });
      if (result.canceled || !result.assets?.length) return;
      setImporting(true);
      const asset = result.assets[0];
      const ext = (asset.name?.split('.').pop() ?? 'pdf').toLowerCase();
      const format: BookFormat =
        ext === 'epub' ? 'epub' : ext === 'txt' || ext === 'md' ? 'txt' : 'pdf';
      const rawTitle = titleFromFilename(asset.name ?? 'Book');

      // Stable ID — same title+format always hashes to the same value so
      // a cloud-restored placeholder automatically merges when the file is re-imported.
      const id = stableBookId(rawTitle, format);

      const destDir = (FileSystem.documentDirectory ?? '') + 'books/';
      await FileSystem.makeDirectoryAsync(destDir, { intermediates: true });
      const destPath = destDir + id + '.' + ext;
      await FileSystem.copyAsync({ from: asset.uri, to: destPath });

      // Check for existing entry (placeholder from cloud restore, or duplicate import)
      const existing = await getBookById(id);

      const book: BookRow = {
        id,
        // Prefer the cloud-restored title/author if available (may be cleaner)
        title: existing?.title && existing.title !== 'Unknown' ? existing.title : rawTitle,
        author: existing?.author ?? '',
        file_uri: destPath,
        format,
        cover_uri: existing?.cover_uri ?? null,   // keep restored cover
        added_at: existing?.added_at ?? Date.now(),
        last_read_at: existing?.last_read_at ?? null,
        current_page: existing?.current_page ?? 0,
        total_pages: existing?.total_pages ?? 0,
        scroll_offset: existing?.scroll_offset ?? 0,
      };
      await upsertBook(book);
      syncBook(book).catch(() => {});

      // Update list: replace placeholder if it existed, else prepend
      setBooks((prev) => {
        const without = prev.filter((b) => b.id !== id);
        return [book, ...without];
      });

      // Auto-fetch cover only if not already restored from cloud
      if (!book.cover_uri) {
        fetchFirstCoverUrl(book.title).then(async (coverUrl) => {
          if (!coverUrl) return;
          const uri = await downloadCover(coverUrl, id);
          if (uri) {
            await updateBookCover(id, uri);
            syncBook(book, coverUrl).catch(() => {});
            setBooks((prev) => prev.map((b) => b.id === id ? { ...b, cover_uri: uri + '?v=' + Date.now() } : b));
          }
        }).catch(() => {});
      }
    } catch {}
    finally { setImporting(false); }
  }

  // ── Remove ──
  async function handleRemove() {
    if (!selectedBook) return;
    const { id, file_uri } = selectedBook;
    closeSheet(async () => {
      await deleteBook(id);
      try { await FileSystem.deleteAsync(file_uri, { idempotent: true }); } catch {}
      setBooks((prev) => prev.filter((b) => b.id !== id));
    });
  }

  if (loading) {
    return (
      <View style={[s.root, { alignItems: 'center', justifyContent: 'center' }]}>
        <StatusBar barStyle="light-content" />
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  const pct = selectedBook ? progressPercent(selectedBook) : 0;

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bgDeep} />
      <LinearGradient colors={[colors.bgDeep, colors.bg]} style={StyleSheet.absoluteFill} />

      {/* Header */}
      <View style={s.header}>
        <View>
          <Text style={s.headerTitle}>Books</Text>
          {books.length > 0 && <Text style={s.headerSub}>{books.length} {books.length === 1 ? 'book' : 'books'}</Text>}
        </View>
        <TouchableOpacity style={[s.importBtn, importing && { opacity: 0.5 }]} onPress={handleImport} disabled={importing} activeOpacity={0.8}>
          {importing ? <ActivityIndicator color={colors.accent} size="small" /> : <Ionicons name="add" size={22} color={colors.accent} />}
          <Text style={s.importBtnText}>{importing ? 'Importing…' : 'Add book'}</Text>
        </TouchableOpacity>
      </View>

      {/* Grid / empty */}
      {books.length === 0 ? (
        <View style={s.empty}>
          <LinearGradient colors={[colors.accentMuted, 'transparent']} style={s.emptyRing}>
            <Ionicons name="library-outline" size={44} color={colors.accent} />
          </LinearGradient>
          <Text style={s.emptyTitle}>Your library is empty</Text>
          <Text style={s.emptySub}>Import PDFs, EPUBs, or text files. Progress and highlights sync automatically.</Text>
          <TouchableOpacity style={s.emptyBtn} onPress={handleImport} activeOpacity={0.85}>
            <Ionicons name="add-circle-outline" size={18} color={colors.bg} />
            <Text style={s.emptyBtnText}>Import first book</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={books} keyExtractor={(b) => b.id} numColumns={COLS}
          columnWrapperStyle={s.row} contentContainerStyle={s.grid}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => {
            const [c1, c2] = coverGradient(item.id);
            const p = progressPercent(item);
            return (
              <TouchableOpacity style={s.card}
                onPress={() => nav.navigate('BookReader', { bookId: item.id })}
                onLongPress={() => openSheet(item)} delayLongPress={400} activeOpacity={0.88}
              >
                {item.cover_uri
                  ? <Image source={{ uri: item.cover_uri }} style={s.coverImg} resizeMode="cover" />
                  : (
                    <LinearGradient colors={[c1, c2]} style={s.cover}>
                      <View style={s.coverInner}>
                        <View style={s.formatBadge}><Text style={s.formatText}>{item.format.toUpperCase()}</Text></View>
                        <Text style={s.coverTitle} numberOfLines={5}>{item.title}</Text>
                        {item.author ? <Text style={s.coverAuthor} numberOfLines={2}>{item.author}</Text> : null}
                      </View>
                    </LinearGradient>
                  )}
                {/* Slim progress bar at bottom edge */}
                {p > 0 && p < 100 && (
                  <View style={s.cardProgTrack}>
                    <View style={[s.cardProgFill, { width: `${p}%` as any, backgroundColor: colors.accent }]} />
                  </View>
                )}
                {p >= 100 && (
                  <View style={[s.finishedDot, { backgroundColor: colors.success }]}>
                    <Ionicons name="checkmark" size={9} color="#fff" />
                  </View>
                )}
              </TouchableOpacity>
            );
          }}
        />
      )}

      {/* ══ Options sheet ══ */}
      <Modal visible={sheetMounted} transparent animationType="none" statusBarTranslucent onRequestClose={() => closeSheet()}>
        <TouchableWithoutFeedback onPress={() => closeSheet()}>
          <Animated.View style={[StyleSheet.absoluteFill, s.backdrop, { opacity: sheetAnimBg }]} />
        </TouchableWithoutFeedback>
        {selectedBook && (
          <Animated.View style={[s.sheet, { backgroundColor: colors.surface, height: SHEET_H, transform: [{ translateY: sheetAnimY }] }]}>
            <View style={s.handle} />
            {/* Book info */}
            <View style={s.bookRow}>
              {selectedBook.cover_uri
                ? <Image source={{ uri: selectedBook.cover_uri }} style={s.thumb} resizeMode="cover" />
                : <LinearGradient colors={coverGradient(selectedBook.id)} style={s.thumb}><Text style={s.thumbLetter}>{selectedBook.title.charAt(0).toUpperCase()}</Text></LinearGradient>}
              <View style={s.bookMeta}>
                <Text style={[s.bookMetaTitle, { color: colors.text }]} numberOfLines={2}>{selectedBook.title}</Text>
                {selectedBook.author ? <Text style={[s.bookMetaAuthor, { color: colors.textMuted }]} numberOfLines={1}>{selectedBook.author}</Text> : null}
                {pct > 0 && (
                  <View style={s.progRow}>
                    <View style={[s.progBarTrack, { backgroundColor: colors.surfaceHigher }]}>
                      <View style={[s.progBarFill, { width: `${pct}%` as any, backgroundColor: colors.accent }]} />
                    </View>
                    <Text style={[s.progPct, { color: colors.textMuted }]}>{pct}%</Text>
                  </View>
                )}
              </View>
            </View>
            <View style={[s.divider, { backgroundColor: colors.border }]} />
            <TouchableOpacity style={s.action} onPress={() => closeSheet(() => nav.navigate('BookReader', { bookId: selectedBook.id }))} activeOpacity={0.75}>
              <View style={[s.actionIcon, { backgroundColor: colors.accentMuted }]}><Ionicons name={pct > 0 ? 'play' : 'book-outline'} size={18} color={colors.accent} /></View>
              <Text style={[s.actionLabel, { color: colors.text }]}>{pct > 0 ? 'Continue reading' : 'Start reading'}</Text>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </TouchableOpacity>
            <TouchableOpacity style={s.action} onPress={() => closeSheet(() => openPicker(selectedBook))} activeOpacity={0.75}>
              <View style={[s.actionIcon, { backgroundColor: colors.accentMuted }]}><Ionicons name="image-outline" size={18} color={colors.accent} /></View>
              <View style={{ flex: 1 }}>
                <Text style={[s.actionLabel, { color: colors.text }]}>{selectedBook.cover_uri ? 'Change cover' : 'Download book cover'}</Text>
                <Text style={[s.actionSub, { color: colors.textMuted }]}>Search Google Images</Text>
              </View>
            </TouchableOpacity>
            <View style={[s.divider, { backgroundColor: colors.border }]} />
            <TouchableOpacity style={s.action} onPress={handleRemove} activeOpacity={0.75}>
              <View style={[s.actionIcon, { backgroundColor: colors.dangerMuted }]}><Ionicons name="trash-outline" size={18} color={colors.danger} /></View>
              <Text style={[s.actionLabel, { color: colors.danger }]}>Remove book</Text>
            </TouchableOpacity>
            <View style={{ height: 24 }} />
          </Animated.View>
        )}
      </Modal>

      {/* ══ Cover picker (Google Images WebView) ══ */}
      <Modal visible={pickerMounted} transparent animationType="none" statusBarTranslucent onRequestClose={() => closePicker()}>
        <Animated.View style={[StyleSheet.absoluteFill, s.backdrop, { opacity: pickerAnimBg }]} />
        <Animated.View style={[s.pickerSheet, { backgroundColor: colors.bgDeep, transform: [{ translateY: pickerAnimY }] }]}>
          {/* Header bar */}
          <View style={[s.pickerHeader, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
            <TouchableOpacity style={s.pickerBack} onPress={() => closePicker()}>
              <Ionicons name="arrow-back" size={22} color={colors.text} />
            </TouchableOpacity>
            <Text style={[s.pickerTitle, { color: colors.text }]}>Download Book Cover</Text>
            {webViewLoading && <ActivityIndicator color={colors.accent} size="small" style={{ marginRight: 4 }} />}
          </View>

          {/* WebView */}
          {pickerBook && (
            <WebView
              source={{ uri: imageSearchUrl(pickerBook.title) }}
              userAgent={WEBVIEW_UA}
              style={{ flex: 1, backgroundColor: colors.bgDeep }}
              injectedJavaScript={COVER_PICKER_JS}
              onMessage={handleWebViewMessage}
              onLoadStart={() => setWebViewLoading(true)}
              onLoadEnd={() => setWebViewLoading(false)}
              javaScriptEnabled
              domStorageEnabled
              sharedCookiesEnabled
              allowsBackForwardNavigationGestures
            />
          )}

          {/* Tip bar */}
          {!pickerSelectedUrl && (
            <View style={[s.tipBar, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
              <Ionicons name="hand-left-outline" size={15} color={colors.textMuted} />
              <Text style={[s.tipText, { color: colors.textMuted }]}>Long-press any image to select it</Text>
            </View>
          )}

          {/* Confirmation bar — appears when image is selected */}
          {pickerSelectedUrl && (
            <View style={[s.confirmBar, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
              <Image source={{ uri: pickerSelectedUrl }} style={s.confirmThumb} resizeMode="cover" />
              <View style={{ flex: 1, marginHorizontal: 12 }}>
                <Text style={[s.confirmLabel, { color: colors.text }]}>Cover selected</Text>
                <Text style={[s.confirmSub, { color: colors.textMuted }]}>Tap OK to apply</Text>
              </View>
              <TouchableOpacity
                style={[s.confirmBtn, s.confirmCancel, { borderColor: colors.border }]}
                onPress={() => setPickerSelectedUrl(null)}
              >
                <Text style={[s.confirmBtnText, { color: colors.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.confirmBtn, s.confirmOk, { backgroundColor: colors.accent }]}
                onPress={handleApplyCover}
                disabled={pickerApplying}
              >
                {pickerApplying
                  ? <ActivityIndicator color={colors.bg} size="small" />
                  : <Text style={[s.confirmBtnText, { color: colors.bg }]}>OK</Text>}
              </TouchableOpacity>
            </View>
          )}
        </Animated.View>
      </Modal>
    </View>
  );
}

function createStyles(colors: ReturnType<typeof useColors>) { return StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgDeep },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 60, paddingHorizontal: space.lg, paddingBottom: space.md,
  },
  headerTitle: { ...T.d2, color: colors.text },
  headerSub: { ...T.caption, color: colors.textMuted, marginTop: 2 },
  importBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.accentMuted, borderRadius: radius.full,
    paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderColor: colors.accentBorder,
  },
  importBtnText: { ...T.badge, color: colors.accent },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.xl },
  emptyRing: { width: 104, height: 104, borderRadius: 52, alignItems: 'center', justifyContent: 'center', marginBottom: space.lg },
  emptyTitle: { ...T.h1, color: colors.text, marginBottom: space.sm, textAlign: 'center' },
  emptySub: { ...T.body, color: colors.textMuted, textAlign: 'center', lineHeight: 24, marginBottom: space.lg },
  emptyBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.accent, borderRadius: radius.full, paddingHorizontal: 20, paddingVertical: 12 },
  emptyBtnText: { ...T.body, color: colors.bg, fontWeight: '700' },

  grid: { paddingHorizontal: space.md, paddingBottom: 100, paddingTop: space.sm },
  row: { gap: COL_GAP, marginBottom: COL_GAP },
  card: { width: CARD_W, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.surface },
  cover: { width: CARD_W, height: COVER_H },
  coverImg: { width: CARD_W, height: COVER_H },
  coverInner: { flex: 1, justifyContent: 'space-between', padding: 8 },
  formatBadge: { alignSelf: 'flex-start', borderRadius: radius.sm, paddingHorizontal: 5, paddingVertical: 2, backgroundColor: 'rgba(0,0,0,0.35)' },
  formatText: { fontSize: 8, fontWeight: '800', color: 'rgba(255,255,255,0.85)', letterSpacing: 0.8 },
  coverTitle: { fontSize: 11, fontWeight: '700', color: 'rgba(255,255,255,0.95)', lineHeight: 15, marginTop: 4 },
  coverAuthor: { fontSize: 9, color: 'rgba(255,255,255,0.65)', lineHeight: 12, marginTop: 2 },
  cardProgTrack: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 2.5, backgroundColor: 'rgba(0,0,0,0.25)' },
  cardProgFill: { height: 2.5 },
  finishedDot: { position: 'absolute', bottom: 5, right: 5, width: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },

  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.65)' },
  sheet: { position: 'absolute', bottom: 0, left: 0, right: 0, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, overflow: 'hidden' },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginTop: 12, marginBottom: 4 },
  bookRow: { flexDirection: 'row', gap: 14, padding: space.lg, paddingBottom: space.md },
  thumb: { width: 60, height: 84, borderRadius: radius.md, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  thumbLetter: { fontSize: 28, fontWeight: '800', color: 'rgba(255,255,255,0.9)' },
  bookMeta: { flex: 1, justifyContent: 'center', gap: 4 },
  bookMetaTitle: { ...T.h3, lineHeight: 22 },
  bookMetaAuthor: { ...T.caption },
  progRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  progBarTrack: { flex: 1, height: 4, borderRadius: 2, overflow: 'hidden' },
  progBarFill: { height: 4, borderRadius: 2 },
  progPct: { ...T.caption, fontSize: 11, fontWeight: '600', minWidth: 28, textAlign: 'right' },
  divider: { height: StyleSheet.hairlineWidth, marginHorizontal: space.md },
  action: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: space.lg, paddingVertical: 14 },
  actionIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  actionLabel: { ...T.body },
  actionSub: { ...T.caption, marginTop: 1 },

  pickerSheet: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  pickerHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingTop: 52, paddingBottom: 12, paddingHorizontal: space.md,
    borderBottomWidth: 1,
  },
  pickerBack: { padding: 4 },
  pickerTitle: { ...T.h3, flex: 1 },

  tipBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: space.lg, paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tipText: { ...T.caption },

  confirmBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: space.md, paddingVertical: 12,
    borderTopWidth: 1, gap: 0,
  },
  confirmThumb: { width: 44, height: 60, borderRadius: radius.sm },
  confirmLabel: { ...T.body, fontWeight: '600', fontSize: 14 },
  confirmSub: { ...T.caption, marginTop: 2 },
  confirmBtn: {
    height: 40, minWidth: 64, borderRadius: radius.full,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18,
    marginLeft: 8,
  },
  confirmCancel: { borderWidth: 1 },
  confirmOk: {},
  confirmBtnText: { ...T.body, fontWeight: '700', fontSize: 14 },
}); }
