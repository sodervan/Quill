import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
// react-native-pdf requires a native EAS build; guard against Expo Go / missing module
let Pdf: any = null;
try { Pdf = require('react-native-pdf').default; } catch {}
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../../../theme/ThemeContext';
import { type as T, space, radius } from '../../../theme';
import type { BookHighlightRow } from '../../../data/books';

type ReadingTheme = 'default' | 'sepia' | 'night';

interface Props {
  fileUri: string;
  initialPage: number;
  onPageChanged: (page: number, total: number) => void;
  onAddNote: (page: number) => void;
  highlights: BookHighlightRow[];
  readingTheme?: ReadingTheme;
  /** Bump this (with a new page number) to jump the already-mounted reader to a page —
   *  e.g. locating a highlight tapped from the in-reader highlights list. */
  jumpToPage?: number | null;
}

const PDF_THEME_OVERLAY: Record<ReadingTheme, string | null> = {
  default: null,
  sepia:   'rgba(180,130,70,0.14)',
  night:   'rgba(0,0,12,0.60)',
};

export default function PdfReader({
  fileUri, initialPage, onPageChanged, onAddNote, highlights, readingTheme = 'default', jumpToPage,
}: Props) {
  const colors = useColors();
  const [totalPages, setTotalPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(initialPage || 1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const pageRef = useRef(currentPage);
  const pdfRef = useRef<any>(null);
  const lastJumpRef = useRef<number | null | undefined>(jumpToPage);

  useEffect(() => {
    if (jumpToPage === lastJumpRef.current) return;
    lastJumpRef.current = jumpToPage;
    if (jumpToPage != null) pdfRef.current?.setPage?.(jumpToPage);
  }, [jumpToPage]);

  // Note indicator for current page
  const pageHasNote = highlights.some(
    (h) => h.page === pageRef.current && h.note,
  );

  useEffect(() => { pageRef.current = currentPage; }, [currentPage]);

  function handlePageChanged(page: number, total: number) {
    setCurrentPage(page);
    pageRef.current = page;
    onPageChanged(page, total);
  }

  if (!Pdf) {
    return (
      <View style={s.centered}>
        <Ionicons name="alert-circle-outline" size={48} color={colors.textMuted} />
        <Text style={[s.errorText, { color: colors.textMuted }]}>PDF reader unavailable</Text>
        <Text style={[s.errorSub, { color: colors.textMuted }]}>
          PDF reading requires a production build. Install the app via EAS to read PDFs.
        </Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={s.centered}>
        <Ionicons name="alert-circle-outline" size={48} color={colors.textMuted} />
        <Text style={[s.errorText, { color: colors.textMuted }]}>Couldn't open this PDF</Text>
        <Text style={[s.errorSub, { color: colors.textMuted }]}>
          The file may be missing or corrupted. Try re-importing it.
        </Text>
      </View>
    );
  }

  return (
    <View style={s.root}>
      {loading && (
        <View style={[StyleSheet.absoluteFill, s.centered, { zIndex: 10 }]}>
          <ActivityIndicator color={colors.accent} size="large" />
          <Text style={[s.loadingText, { color: colors.textMuted }]}>Opening PDF…</Text>
        </View>
      )}

      <Pdf
        ref={pdfRef}
        source={{ uri: fileUri, cache: true }}
        page={initialPage || 1}
        onLoadComplete={(pages: number) => {
          setTotalPages(pages);
          setLoading(false);
        }}
        onPageChanged={handlePageChanged}
        onError={() => { setError(true); setLoading(false); }}
        enablePaging
        horizontal
        style={[s.pdf, { backgroundColor: colors.bgDeep }]}
        renderActivityIndicator={() => <ActivityIndicator color={colors.accent} />}
        enableAntialiasing
      />

      {/* Sepia / night tint overlay */}
      {PDF_THEME_OVERLAY[readingTheme] && (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: PDF_THEME_OVERLAY[readingTheme]! }]}
        />
      )}

      {/* Page note indicator + add-note FAB */}
      {!loading && (
        <View style={s.fab}>
          <TouchableOpacity
            style={[
              s.fabBtn,
              { backgroundColor: pageHasNote ? colors.accent : colors.surface,
                borderColor: colors.accentBorder },
            ]}
            onPress={() => onAddNote(pageRef.current)}
            activeOpacity={0.85}
          >
            <Ionicons
              name={pageHasNote ? 'document-text' : 'document-text-outline'}
              size={22}
              color={pageHasNote ? colors.bg : colors.accent}
            />
          </TouchableOpacity>
        </View>
      )}

      {/* Page counter */}
      {!loading && totalPages > 0 && (
        <View style={[s.counter, { backgroundColor: colors.surface + 'CC', borderColor: colors.border }]}>
          <Text style={[s.counterText, { color: colors.textMuted }]}>
            {currentPage} / {totalPages}
          </Text>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  pdf: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { ...T.caption, marginTop: 8 },
  errorText: { ...T.h2, textAlign: 'center' },
  errorSub: { ...T.caption, textAlign: 'center', paddingHorizontal: 32, lineHeight: 20 },
  fab: { position: 'absolute', bottom: 32, right: space.md },
  fabBtn: {
    width: 48, height: 48, borderRadius: 24,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, elevation: 6,
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
  },
  counter: {
    position: 'absolute', bottom: 32, alignSelf: 'center',
    paddingHorizontal: 12, paddingVertical: 5,
    borderRadius: radius.full, borderWidth: 1,
  },
  counterText: { ...T.caption, fontWeight: '600' },
});
