import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Animated, Dimensions, KeyboardAvoidingView, Platform,
  ScrollView, StatusBar, StyleSheet, Text, TextInput,
  TouchableOpacity, TouchableWithoutFeedback, View,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { WebView } from 'react-native-webview';
import * as FileSystem from 'expo-file-system/legacy';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

import { RootStackParamList } from '../../navigation';
import { type as T, space, radius } from '../../theme';
import { useColors, useTheme } from '../../theme/ThemeContext';
import {
  getBookById, updateBookProgress, upsertBookHighlight,
  getBookHighlights, deleteBookHighlight, updateBookHighlightNote,
  type BookRow, type BookHighlightRow,
} from '../../data/books';
import PdfReader from './components/PdfReader';
import EpubReader, { type ReadingTheme } from './components/EpubReader';

type Props = NativeStackScreenProps<RootStackParamList, 'BookReader'>;

const { height: SCREEN_H } = Dimensions.get('window');
const SHEET_H = Math.min(520, SCREEN_H * 0.68);
const LIST_SHEET_H = Math.min(560, SCREEN_H * 0.72);

const HIGHLIGHT_COLORS = ['#C8AA6E', '#F97316', '#34D399', '#60A5FA', '#F472B6'];

function generateId() {
  return `hl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ---- Plain-text / TXT reader (simple WebView) ----
const TXT_THEME_COLORS: Record<ReadingTheme, { bg: string; fg: string; link: string } | null> = {
  default: null,
  sepia:   { bg: '#F5EDD8', fg: '#2E1F0F', link: '#7A4B28' },
  night:   { bg: '#0E0E12', fg: '#C4BEB5', link: '#A8895C' },
};

const TXT_SELECTION_JS = `
(function(){
  var cachedSel='';
  var hint=document.createElement('div');
  hint.style.cssText='display:none;position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.82);color:#fff;padding:7px 15px;border-radius:20px;font-size:12px;font-family:system-ui;z-index:9999;pointer-events:none;white-space:nowrap;';
  hint.textContent='\\u270E  Tap selection to highlight';
  document.body.appendChild(hint);
  document.addEventListener('selectionchange',function(){
    var sel=window.getSelection();var t=sel?sel.toString().trim():'';
    if(t.length>2){cachedSel=t;hint.style.display='block';}
    else{hint.style.display='none';}
  });
  function sendSel(){var s=window.getSelection();var t=(s?s.toString().trim():'')||cachedSel;if(t.length>2){window.ReactNativeWebView.postMessage(JSON.stringify({type:'selection',text:t}));hint.style.display='none';cachedSel='';}}
  document.addEventListener('mouseup',sendSel);
  document.addEventListener('touchend',sendSel);
})();
true;`;

function buildTxtApplyHighlightsJS(items: Array<{ text: string; color: string }>): string {
  const data = JSON.stringify(items);
  return `(function(){function applyHL(txt,color){var walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);var node;while((node=walker.nextNode())){var v=node.nodeValue||'';var i=v.indexOf(txt);if(i<0)continue;var span=document.createElement('span');span.style.cssText='background:'+color+'55;border-radius:2px;padding:0 1px;';var r=document.createRange();r.setStart(node,i);r.setEnd(node,i+txt.length);try{r.surroundContents(span);}catch(e){}break;}}var hs=${data};hs.forEach(function(h){try{applyHL(h.text,h.color);}catch(e){}});})();true;`;
}

function TxtReader({
  fileUri, onReady, isDark, rawMode, readingTheme,
  onTextSelected, highlights, currentPage,
}: {
  fileUri: string; onReady: (total: number) => void;
  isDark: boolean;
  rawMode: boolean; readingTheme: ReadingTheme;
  onTextSelected: (text: string) => void;
  highlights: BookHighlightRow[];
  currentPage: number;
}) {
  const [html, setHtml] = useState('');
  const txtWebViewRef = React.useRef<WebView>(null);
  const appliedHLRef = React.useRef<Set<string>>(new Set());

  useEffect(() => {
    FileSystem.readAsStringAsync(fileUri)
      .then((rawText) => {
        const tc = TXT_THEME_COLORS[readingTheme];
        const bg   = tc ? tc.bg   : (isDark ? '#090C15' : '#F5F4F0');
        const fg   = tc ? tc.fg   : (isDark ? '#EDE8E0' : '#1C1A17');
        const link = tc ? tc.link : (isDark ? '#C8AA6E' : '#A67C3D');

        let bodyHtml: string;
        if (rawMode) {
          const escaped = rawText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          bodyHtml = `<pre>${escaped}</pre>`;
        } else {
          bodyHtml = rawText.split(/\n\n+/).map((p) => `<p>${p.replace(/\n/g,'<br>')}</p>`).join('');
        }

        const built = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>
  * { box-sizing:border-box; }
  html,body { margin:0; padding:0; background:${bg}; }
  body { font-family:${rawMode ? "'Courier New',monospace" : "Georgia,serif"}; font-size:${rawMode ? '13' : '17'}px;
    line-height:${rawMode ? '1.55' : '1.8'}; color:${fg};
    padding:${rawMode ? '12px 12px 80px' : '24px 22px 80px'}; word-break:break-word; }
  p { margin:0 0 16px; }
  pre { margin:0; white-space:pre-wrap; }
  ::selection { background:${link}44; }
</style></head><body>${bodyHtml}</body></html>`;
        setHtml(built);
        // HTML rebuild = new page, reset applied tracking
        appliedHLRef.current = new Set();
        const words = rawText.split(/\s+/).length;
        onReady(Math.max(1, Math.ceil(words / 250)));
      })
      .catch(() => setHtml('<p style="color:#888;padding:32px">Could not read file.</p>'));
  }, [fileUri, rawMode, isDark, readingTheme]);

  // After page loads: apply all highlights for this page
  function handleLoadEnd() {
    appliedHLRef.current = new Set();
    const forPage = highlights.filter((h) => h.page === currentPage && h.selected_text);
    if (!txtWebViewRef.current || forPage.length === 0) return;
    forPage.forEach((h) => appliedHLRef.current.add(h.id));
    txtWebViewRef.current.injectJavaScript(
      buildTxtApplyHighlightsJS(forPage.map((h) => ({ text: h.selected_text, color: h.color })))
    );
  }

  // When highlights change: inject only newly added ones
  useEffect(() => {
    const forPage = highlights.filter((h) => h.page === currentPage && h.selected_text);
    const newOnes = forPage.filter((h) => !appliedHLRef.current.has(h.id));
    if (!txtWebViewRef.current || newOnes.length === 0) return;
    newOnes.forEach((h) => appliedHLRef.current.add(h.id));
    txtWebViewRef.current.injectJavaScript(
      buildTxtApplyHighlightsJS(newOnes.map((h) => ({ text: h.selected_text, color: h.color })))
    );
  }, [highlights, currentPage]);

  return (
    <WebView
      ref={txtWebViewRef}
      source={{ html, baseUrl: '' }}
      style={{ flex: 1, backgroundColor: isDark ? '#090C15' : '#F5F4F0' }}
      injectedJavaScript={TXT_SELECTION_JS}
      onLoadEnd={handleLoadEnd}
      onMessage={(e) => {
        try {
          const m = JSON.parse(e.nativeEvent.data);
          if (m.type === 'selection') onTextSelected(m.text);
        } catch {}
      }}
      scrollEnabled showsVerticalScrollIndicator={false} overScrollMode="never"
      originWhitelist={['*']} javaScriptEnabled
    />
  );
}

// ---- Main screen ----
export default function BookReaderScreen({ route, navigation }: Props) {
  const colors = useColors();
  const { isDark } = useTheme();
  const { bookId, initialPage } = route.params;

  const [book, setBook] = useState<BookRow | null>(null);
  const [highlights, setHighlights] = useState<BookHighlightRow[]>([]);
  const [currentPage, setCurrentPage] = useState(initialPage ?? 0);
  const [totalPages, setTotalPages] = useState(0);
  const [fileExists, setFileExists] = useState(true);
  const [rawMode, setRawMode] = useState(false);
  const [readingTheme, setReadingTheme] = useState<ReadingTheme>('default');
  const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const THEMES: ReadingTheme[] = ['default', 'sepia', 'night'];
  const THEME_META: Record<ReadingTheme, { icon: string; color: string; label: string }> = {
    default: { icon: 'sunny-outline',  color: colors.textMuted, label: 'Default' },
    sepia:   { icon: 'leaf-outline',   color: '#8B6040',        label: 'Sepia'   },
    night:   { icon: 'moon-outline',   color: '#7B9CC8',        label: 'Night'   },
  };
  function cycleTheme() {
    setReadingTheme((t) => THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]);
  }

  // ── Highlight / note add sheet ──
  const [sheetState, setSheetState] = useState<
    | { mode: 'add'; text: string; page: number }
    | { mode: 'edit'; highlight: BookHighlightRow }
    | null
  >(null);
  const [noteText, setNoteText] = useState('');
  const [selectedColor, setSelectedColor] = useState(HIGHLIGHT_COLORS[0]);
  const sheetAnimY = useRef(new Animated.Value(SHEET_H)).current;
  const sheetAnimBg = useRef(new Animated.Value(0)).current;
  const [sheetMounted, setSheetMounted] = useState(false);

  // ── Highlights list sheet ──
  const [listVisible, setListVisible] = useState(false);
  const listAnimY = useRef(new Animated.Value(LIST_SHEET_H)).current;
  const listAnimBg = useRef(new Animated.Value(0)).current;
  const [listMounted, setListMounted] = useState(false);

  const s = useMemo(() => createStyles(colors), [colors]);

  // Load book + highlights
  useEffect(() => {
    getBookById(bookId).then(async (b) => {
      if (!b) { navigation.goBack(); return; }
      setBook(b);
      // initialPage (from highlight navigation) overrides saved progress
      setCurrentPage(initialPage ?? b.current_page);
      setTotalPages(b.total_pages);

      // Check file exists
      const info = await FileSystem.getInfoAsync(b.file_uri);
      setFileExists(info.exists);

      const hl = await getBookHighlights(bookId);
      setHighlights(hl);
    });
  }, [bookId]);

  // Debounced progress save
  function handleProgressChange(page: number, total: number) {
    setCurrentPage(page);
    setTotalPages(total);
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(() => {
      updateBookProgress(bookId, page, total).catch(() => {});
    }, 1500);
  }

  // ── Sheet: open/close ──
  function openSheet(state: NonNullable<typeof sheetState>) {
    if (state.mode === 'edit') {
      setNoteText(state.highlight.note ?? '');
      setSelectedColor(state.highlight.color);
    } else {
      setNoteText('');
      setSelectedColor(HIGHLIGHT_COLORS[0]);
    }
    setSheetState(state);
    setSheetMounted(true);
    Animated.parallel([
      Animated.spring(sheetAnimY, { toValue: 0, tension: 80, friction: 13, useNativeDriver: true }),
      Animated.timing(sheetAnimBg, { toValue: 1, duration: 220, useNativeDriver: true }),
    ]).start();
  }

  function closeSheet(cb?: () => void) {
    Animated.parallel([
      Animated.timing(sheetAnimY, { toValue: SHEET_H, duration: 260, useNativeDriver: true }),
      Animated.timing(sheetAnimBg, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start(() => { setSheetMounted(false); setSheetState(null); cb?.(); });
  }

  async function saveHighlight() {
    if (!sheetState) return;
    if (sheetState.mode === 'add') {
      const h: BookHighlightRow = {
        id: generateId(),
        book_id: bookId,
        page: sheetState.page,
        cfi: null,
        selected_text: sheetState.text,
        color: selectedColor,
        note: noteText.trim() || null,
        created_at: Date.now(),
      };
      await upsertBookHighlight(h);
      setHighlights((prev) => [...prev, h]);
    } else {
      const updated = {
        ...sheetState.highlight,
        color: selectedColor,
        note: noteText.trim() || null,
      };
      await upsertBookHighlight(updated);
      if (noteText.trim()) {
        await updateBookHighlightNote(sheetState.highlight.id, noteText.trim());
      }
      setHighlights((prev) => prev.map((h) => h.id === updated.id ? updated : h));
    }
    closeSheet();
  }

  async function deleteCurrentHighlight() {
    if (!sheetState || sheetState.mode !== 'edit') return;
    const id = sheetState.highlight.id;
    closeSheet(async () => {
      await deleteBookHighlight(id);
      setHighlights((prev) => prev.filter((h) => h.id !== id));
    });
  }

  // ── List sheet: open/close ──
  function openList() {
    setListMounted(true);
    setListVisible(true);
    Animated.parallel([
      Animated.spring(listAnimY, { toValue: 0, tension: 80, friction: 13, useNativeDriver: true }),
      Animated.timing(listAnimBg, { toValue: 1, duration: 220, useNativeDriver: true }),
    ]).start();
  }

  function closeList(cb?: () => void) {
    Animated.parallel([
      Animated.timing(listAnimY, { toValue: LIST_SHEET_H, duration: 260, useNativeDriver: true }),
      Animated.timing(listAnimBg, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start(() => { setListMounted(false); setListVisible(false); cb?.(); });
  }

  // ── Reader callbacks ──
  function handleTextSelected(text: string, page: number) {
    openSheet({ mode: 'add', text, page });
  }

  function handleAddNote(page: number) {
    openSheet({ mode: 'add', text: '', page });
  }

  if (!book) {
    return <View style={[s.root, { justifyContent: 'center', alignItems: 'center' }]} />;
  }

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bgDeep} />

      {/* Header */}
      <LinearGradient
        colors={[colors.bgDeep, colors.bgDeep + 'EE']}
        style={s.header}
      >
        <TouchableOpacity style={s.headerBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>

        <View style={s.headerCenter}>
          <Text style={s.headerTitle} numberOfLines={1}>{book.title}</Text>
          {book.author ? (
            <Text style={s.headerAuthor} numberOfLines={1}>{book.author}</Text>
          ) : null}
        </View>

        {/* Reading theme cycle */}
        <TouchableOpacity style={s.headerBtn} onPress={cycleTheme}>
          <Ionicons
            name={THEME_META[readingTheme].icon as any}
            size={20}
            color={THEME_META[readingTheme].color}
          />
        </TouchableOpacity>

        {/* Raw mode toggle — only for epub/txt */}
        {book?.format !== 'pdf' && (
          <TouchableOpacity
            style={s.headerBtn}
            onPress={() => setRawMode((v) => !v)}
          >
            <Ionicons
              name={rawMode ? 'reader' : 'reader-outline'}
              size={20}
              color={rawMode ? colors.accent : colors.textMuted}
            />
          </TouchableOpacity>
        )}

        <TouchableOpacity style={s.headerBtn} onPress={openList}>
          <Ionicons name="bookmark-outline" size={22} color={colors.accent} />
          {highlights.length > 0 && (
            <View style={[s.badge, { backgroundColor: colors.accent }]}>
              <Text style={[s.badgeText, { color: colors.bg }]}>
                {highlights.length > 99 ? '99+' : highlights.length}
              </Text>
            </View>
          )}
        </TouchableOpacity>
      </LinearGradient>

      {/* File missing warning */}
      {!fileExists ? (
        <View style={[s.missingBanner, { backgroundColor: colors.flameMuted, borderColor: colors.flame }]}>
          <Ionicons name="warning-outline" size={16} color={colors.flame} />
          <Text style={[s.missingText, { color: colors.flame }]}>
            File not found on this device. Re-import to read — your progress and highlights are saved.
          </Text>
        </View>
      ) : null}

      {/* Reader body */}
      {fileExists && book.format === 'pdf' && (
        <PdfReader
          fileUri={book.file_uri}
          initialPage={(initialPage ?? book.current_page) || 1}
          onPageChanged={handleProgressChange}
          onAddNote={handleAddNote}
          highlights={highlights}
          readingTheme={readingTheme}
        />
      )}
      {fileExists && book.format === 'epub' && (
        <EpubReader
          fileUri={book.file_uri}
          initialChapter={(initialPage ?? book.current_page) || 0}
          onChapterChanged={(ch, total) => handleProgressChange(ch, total)}
          onTextSelected={handleTextSelected}
          onAddNote={handleAddNote}
          highlights={highlights}
          rawMode={rawMode}
          readingTheme={readingTheme}
        />
      )}
      {fileExists && book.format === 'txt' && (
        <TxtReader
          fileUri={book.file_uri}
          isDark={isDark}
          rawMode={rawMode}
          readingTheme={readingTheme}
          onReady={(total) => setTotalPages(total)}
          onTextSelected={(text) => handleTextSelected(text, currentPage)}
          highlights={highlights}
          currentPage={currentPage}
        />
      )}

      {/* ── Highlight/Note sheet ── */}
      {sheetMounted && (
        <TouchableWithoutFeedback onPress={() => closeSheet()}>
          <Animated.View style={[StyleSheet.absoluteFill, s.backdrop, { opacity: sheetAnimBg }]} />
        </TouchableWithoutFeedback>
      )}
      {sheetMounted && (
        <Animated.View
          style={[
            s.sheet,
            { backgroundColor: colors.surface, height: SHEET_H, transform: [{ translateY: sheetAnimY }] },
          ]}
        >
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
            <View style={s.sheetHandle} />

            <View style={s.sheetHeader}>
              <Text style={[s.sheetTitle, { color: colors.text }]}>
                {sheetState?.mode === 'edit' ? 'Edit highlight' : 'Add highlight'}
              </Text>
              <TouchableOpacity onPress={() => closeSheet()}>
                <Ionicons name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ flex: 1 }} contentContainerStyle={s.sheetBody} keyboardShouldPersistTaps="handled">
              {/* Selected text preview */}
              {sheetState?.mode === 'add' && sheetState.text ? (
                <View style={[s.quoteBubble, { backgroundColor: colors.surfaceHigher, borderLeftColor: selectedColor }]}>
                  <Text style={[s.quoteText, { color: colors.textSecondary }]} numberOfLines={4}>
                    "{sheetState.text}"
                  </Text>
                </View>
              ) : sheetState?.mode === 'add' && !sheetState.text ? (
                <Text style={[s.pageNote, { color: colors.textMuted }]}>
                  Note for page {sheetState.page + 1}
                </Text>
              ) : sheetState?.mode === 'edit' && sheetState.highlight.selected_text ? (
                <View style={[s.quoteBubble, { backgroundColor: colors.surfaceHigher, borderLeftColor: selectedColor }]}>
                  <Text style={[s.quoteText, { color: colors.textSecondary }]} numberOfLines={4}>
                    "{sheetState.highlight.selected_text}"
                  </Text>
                </View>
              ) : null}

              {/* Color picker */}
              <View style={s.colorRow}>
                {HIGHLIGHT_COLORS.map((c) => (
                  <TouchableOpacity
                    key={c}
                    style={[s.colorDot, { backgroundColor: c }, selectedColor === c && s.colorDotSelected]}
                    onPress={() => setSelectedColor(c)}
                  />
                ))}
              </View>

              {/* Note input */}
              <TextInput
                style={[s.noteInput, { backgroundColor: colors.surfaceHigher, color: colors.text, borderColor: colors.border }]}
                placeholder="Add a note (optional)…"
                placeholderTextColor={colors.textMuted}
                multiline
                numberOfLines={4}
                value={noteText}
                onChangeText={setNoteText}
                textAlignVertical="top"
              />
            </ScrollView>

            {/* Actions */}
            <View style={[s.sheetActions, { borderTopColor: colors.border }]}>
              {sheetState?.mode === 'edit' && (
                <TouchableOpacity
                  style={[s.deleteBtn, { borderColor: colors.border }]}
                  onPress={deleteCurrentHighlight}
                >
                  <Ionicons name="trash-outline" size={18} color={colors.flame} />
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[s.saveBtn, { backgroundColor: selectedColor }]}
                onPress={saveHighlight}
              >
                <Text style={[s.saveBtnText, { color: '#090C15' }]}>
                  {sheetState?.mode === 'edit' ? 'Update' : 'Save highlight'}
                </Text>
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        </Animated.View>
      )}

      {/* ── Highlights list sheet ── */}
      {listMounted && (
        <TouchableWithoutFeedback onPress={() => closeList()}>
          <Animated.View style={[StyleSheet.absoluteFill, s.backdrop, { opacity: listAnimBg }]} />
        </TouchableWithoutFeedback>
      )}
      {listMounted && (
        <Animated.View
          style={[
            s.sheet,
            { backgroundColor: colors.surface, height: LIST_SHEET_H, transform: [{ translateY: listAnimY }] },
          ]}
        >
          <View style={s.sheetHandle} />
          <View style={s.sheetHeader}>
            <Text style={[s.sheetTitle, { color: colors.text }]}>
              Highlights{highlights.length > 0 ? ` · ${highlights.length}` : ''}
            </Text>
            <TouchableOpacity onPress={() => closeList()}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          {highlights.length === 0 ? (
            <View style={s.listEmpty}>
              <Ionicons name="bookmark-outline" size={40} color={colors.textMuted} />
              <Text style={[s.listEmptyText, { color: colors.textMuted }]}>No highlights yet</Text>
              <Text style={[s.listEmptySub, { color: colors.textMuted }]}>
                Select text while reading to add highlights and notes.
              </Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={{ paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
              {highlights.map((h) => (
                <TouchableOpacity
                  key={h.id}
                  style={[s.hlItem, { borderBottomColor: colors.border }]}
                  onPress={() => {
                    closeList(() => {
                      openSheet({ mode: 'edit', highlight: h });
                    });
                  }}
                  activeOpacity={0.75}
                >
                  <View style={[s.hlAccent, { backgroundColor: h.color }]} />
                  <View style={s.hlBody}>
                    <Text style={[s.hlPage, { color: colors.textMuted }]}>Page {h.page + 1}</Text>
                    {h.selected_text ? (
                      <Text style={[s.hlText, { color: colors.text }]} numberOfLines={3}>
                        {h.selected_text}
                      </Text>
                    ) : null}
                    {h.note ? (
                      <Text style={[s.hlNote, { color: colors.accent }]} numberOfLines={2}>
                        {h.note}
                      </Text>
                    ) : null}
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </Animated.View>
      )}
    </View>
  );
}

function createStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bgDeep },

    header: {
      flexDirection: 'row', alignItems: 'center',
      paddingTop: 52, paddingBottom: 10, paddingHorizontal: space.sm,
    },
    headerBtn: { padding: 8, minWidth: 44, alignItems: 'center', justifyContent: 'center', position: 'relative' },
    headerCenter: { flex: 1, paddingHorizontal: 4 },
    headerTitle: { ...T.h3, color: colors.text },
    headerAuthor: { ...T.caption, color: colors.textMuted, marginTop: 1 },
    badge: {
      position: 'absolute', top: 2, right: 2,
      minWidth: 16, height: 16, borderRadius: 8,
      alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3,
    },
    badgeText: { fontSize: 10, fontWeight: '800' },

    missingBanner: {
      flexDirection: 'row', alignItems: 'flex-start', gap: 8,
      margin: space.md, padding: 12, borderRadius: radius.md, borderWidth: 1,
    },
    missingText: { ...T.caption, flex: 1, lineHeight: 18 },

    backdrop: { backgroundColor: 'rgba(0,0,0,0.65)' },
    sheet: {
      position: 'absolute', bottom: 0, left: 0, right: 0,
      borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
      overflow: 'hidden',
    },
    sheetHandle: {
      width: 36, height: 4, borderRadius: 2,
      backgroundColor: colors.border, alignSelf: 'center', marginTop: 12, marginBottom: 4,
    },
    sheetHeader: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: space.lg, paddingVertical: space.md,
    },
    sheetTitle: { ...T.h2 },
    sheetBody: { paddingHorizontal: space.lg, paddingBottom: space.md, gap: 16 },
    quoteBubble: {
      padding: 14, borderRadius: radius.md,
      borderLeftWidth: 3,
    },
    quoteText: { ...T.body, fontStyle: 'italic', fontSize: 15, lineHeight: 23 },
    pageNote: { ...T.body, fontStyle: 'italic' },
    colorRow: { flexDirection: 'row', gap: 14, paddingVertical: 4 },
    colorDot: { width: 28, height: 28, borderRadius: 14 },
    colorDotSelected: {
      borderWidth: 3, borderColor: colors.text,
      transform: [{ scale: 1.15 }],
    },
    noteInput: {
      borderWidth: 1, borderRadius: radius.md,
      padding: 12, fontSize: 15, lineHeight: 22,
      minHeight: 100,
    },
    sheetActions: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      paddingHorizontal: space.lg, paddingVertical: space.md,
      borderTopWidth: 1,
    },
    deleteBtn: {
      width: 44, height: 44, borderRadius: radius.md, borderWidth: 1,
      alignItems: 'center', justifyContent: 'center',
    },
    saveBtn: {
      flex: 1, height: 44, borderRadius: radius.full,
      alignItems: 'center', justifyContent: 'center',
    },
    saveBtnText: { ...T.body, fontWeight: '700', fontSize: 15 },

    listEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 40, marginTop: 20 },
    listEmptyText: { ...T.h3 },
    listEmptySub: { ...T.caption, textAlign: 'center', lineHeight: 20 },
    hlItem: {
      flexDirection: 'row', alignItems: 'flex-start', gap: 12,
      paddingHorizontal: space.lg, paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    hlAccent: { width: 4, alignSelf: 'stretch', borderRadius: 2, marginTop: 2 },
    hlBody: { flex: 1 },
    hlPage: { ...T.caption, fontWeight: '600', marginBottom: 4 },
    hlText: { ...T.body, fontSize: 14, lineHeight: 21, marginBottom: 4 },
    hlNote: { ...T.caption, fontStyle: 'italic' },
  });
}
