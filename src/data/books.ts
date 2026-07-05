import { getDb, logBookPages } from './db';

export type BookFormat = 'pdf' | 'epub' | 'txt';

// ─── Stable book ID ───────────────────────────────────────────────────────────
// The same book (possibly with slightly different filenames / subtitle variants)
// should always produce the same ID so cloud-restored placeholders merge with
// a re-imported file automatically.

/**
 * Normalise a book title down to its core ≤5 words, stripping:
 *  - parenthesised noise  (2003), [eBook], etc.
 *  - subtitles after ':'
 *  - leading articles  the / a / an
 *  - "Author - Title" prefixes (libgen pattern): keeps the longest segment
 *  - trailing site tags  – libgen.li, – z-lib, etc.
 *  - all non-alphanumeric characters
 */
export function normalizeBookTitle(title: string): string {
  let t = title.toLowerCase().trim();
  // strip parenthesised/bracketed noise
  t = t.replace(/\s*\([^)]*\)/g, '');
  t = t.replace(/\s*\[[^\]]*\]/g, '');
  // split on ' - ' and pick the longest-word-count segment
  // (title is usually longer than an author name or a site tag)
  const segs = t.split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);
  if (segs.length > 1) {
    t = segs.reduce((best, seg) => {
      const bw = best.split(/\s+/).filter(Boolean).length;
      const sw = seg.split(/\s+/).filter(Boolean).length;
      return sw > bw || (sw === bw && seg.length > best.length) ? seg : best;
    });
  }
  // strip subtitle after ':'
  t = t.replace(/:.*/, '');
  // strip leading article
  t = t.replace(/^(the|a|an)\s+/, '');
  // keep only alphanumeric + spaces
  t = t.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  // first 5 words
  return t.split(' ').filter(Boolean).slice(0, 5).join(' ');
}

/** djb2 hash → stable hex string */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

/**
 * Generate a stable ID for a book from its (normalised) title + format.
 * Including format prevents the EPUB and PDF of the same book from sharing
 * progress (different page counts).
 */
export function stableBookId(title: string, format: BookFormat): string {
  return `book_${djb2(normalizeBookTitle(title) + ':' + format)}`;
}

export interface BookRow {
  id: string;
  title: string;
  author: string;
  file_uri: string;
  format: BookFormat;
  cover_uri: string | null;
  added_at: number;
  last_read_at: number | null;
  current_page: number;
  total_pages: number;
}

export interface BookHighlightRow {
  id: string;
  book_id: string;
  page: number;
  cfi: string | null;
  selected_text: string;
  color: string;
  note: string | null;
  created_at: number;
}

export async function upsertBook(book: BookRow): Promise<void> {
  const db = getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO books
       (id, title, author, file_uri, format, cover_uri, added_at, last_read_at, current_page, total_pages)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [book.id, book.title, book.author, book.file_uri, book.format,
     book.cover_uri ?? null, book.added_at, book.last_read_at ?? null,
     book.current_page, book.total_pages],
  );
}

export async function getAllBooks(): Promise<BookRow[]> {
  const db = getDb();
  return db.getAllAsync<BookRow>(
    `SELECT * FROM books ORDER BY last_read_at DESC, added_at DESC`,
  );
}

export async function getBookById(id: string): Promise<BookRow | null> {
  const db = getDb();
  return db.getFirstAsync<BookRow>(`SELECT * FROM books WHERE id = ?`, [id]);
}

export async function updateBookProgress(
  id: string, page: number, totalPages: number,
): Promise<void> {
  const db = getDb();
  const prev = await db.getFirstAsync<{ current_page: number }>(
    `SELECT current_page FROM books WHERE id = ?`, [id],
  );
  const delta = Math.max(0, page - (prev?.current_page ?? 0));
  await db.runAsync(
    `UPDATE books SET current_page = ?, total_pages = ?, last_read_at = ? WHERE id = ?`,
    [page, totalPages, Date.now(), id],
  );
  if (delta > 0) logBookPages(delta).catch(() => {});
  import('../lib/sync').then((m) => m.syncBookProgress(id, page, totalPages)).catch(() => {});
}

export async function updateBookCover(id: string, coverUri: string): Promise<void> {
  const db = getDb();
  await db.runAsync(`UPDATE books SET cover_uri = ? WHERE id = ?`, [coverUri, id]);
}

export async function deleteBook(id: string): Promise<void> {
  const db = getDb();
  await db.runAsync(`DELETE FROM books WHERE id = ?`, [id]);
  await db.runAsync(`DELETE FROM book_highlights WHERE book_id = ?`, [id]);
  import('../lib/sync').then((m) => m.syncDeleteBook(id)).catch(() => {});
}

export async function upsertBookHighlight(h: BookHighlightRow): Promise<void> {
  const db = getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO book_highlights
       (id, book_id, page, cfi, selected_text, color, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [h.id, h.book_id, h.page, h.cfi ?? null, h.selected_text, h.color, h.note ?? null, h.created_at],
  );
  import('../lib/sync').then((m) => m.syncBookHighlight(h)).catch(() => {});
}

export async function getBookHighlights(bookId: string): Promise<BookHighlightRow[]> {
  const db = getDb();
  return db.getAllAsync<BookHighlightRow>(
    `SELECT * FROM book_highlights WHERE book_id = ? ORDER BY page ASC, created_at ASC`,
    [bookId],
  );
}

export async function deleteBookHighlight(id: string): Promise<void> {
  const db = getDb();
  await db.runAsync(`DELETE FROM book_highlights WHERE id = ?`, [id]);
}

export async function updateBookHighlightNote(id: string, note: string): Promise<void> {
  const db = getDb();
  await db.runAsync(`UPDATE book_highlights SET note = ? WHERE id = ?`, [note, id]);
}

export interface BookHighlightWithTitle extends BookHighlightRow {
  book_title: string;
  book_file_uri: string;
}

export async function getAllBookHighlightsWithTitle(): Promise<BookHighlightWithTitle[]> {
  const db = getDb();
  return db.getAllAsync<BookHighlightWithTitle>(`
    SELECT bh.*,
      COALESCE(b.title, 'Unknown Book') AS book_title,
      COALESCE(b.file_uri, '')          AS book_file_uri
    FROM book_highlights bh
    LEFT JOIN books b ON bh.book_id = b.id
    ORDER BY bh.created_at DESC
  `);
}
