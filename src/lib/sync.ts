import { auth, db } from './firebase';
import {
  doc, setDoc, deleteDoc, getDocs, getDoc, collection, writeBatch,
} from 'firebase/firestore';
import type { RemoteSourceRow, ArticleRow, HighlightRow } from '../data/db';
import type { BookRow, BookHighlightRow } from '../data/books';

function uid(): string | null {
  return auth.currentUser?.uid ?? null;
}

// Firestore doc IDs cannot contain '/'. Article IDs embed URLs, so we escape.
function safeId(id: string): string {
  return id.replace(/\//g, '~');
}

// ── Writes ────────────────────────────────────────────────────────────────────

export async function syncFollow(sourceId: string): Promise<void> {
  const userId = uid();
  if (!userId) return;
  try {
    await setDoc(doc(db, 'users', userId, 'sources', sourceId), { source_id: sourceId });
  } catch {}
}

export async function syncUnfollow(sourceId: string): Promise<void> {
  const userId = uid();
  if (!userId) return;
  try {
    await Promise.all([
      deleteDoc(doc(db, 'users', userId, 'sources', sourceId)),
      deleteDoc(doc(db, 'users', userId, 'remote_sources', sourceId)),
    ]);
  } catch {}
}

export async function syncRemoteSource(src: RemoteSourceRow): Promise<void> {
  const userId = uid();
  if (!userId) return;
  try {
    await setDoc(doc(db, 'users', userId, 'remote_sources', src.id), {
      name: src.name,
      feed_url: src.feed_url,
      description: src.description,
      color: src.color,
      added_at: src.added_at,
    });
  } catch {}
}

export async function syncSave(articleId: string): Promise<void> {
  const userId = uid();
  if (!userId) return;
  try {
    await setDoc(doc(db, 'users', userId, 'saved_articles', safeId(articleId)), {
      article_id: articleId,
    });
  } catch {}
}

export async function syncSaveArticle(article: ArticleRow): Promise<void> {
  const userId = uid();
  if (!userId) return;
  try {
    await setDoc(doc(db, 'users', userId, 'saved_articles', safeId(article.id)), {
      article_id: article.id,
      title: article.title,
      link: article.link,
      publication_id: article.publication_id,
      pub_date: article.pub_date,
      excerpt: article.excerpt ?? null,
      image_url: article.image_url ?? null,
      saved_at: Date.now(),
    });
  } catch {}
}

export async function syncUnsave(articleId: string): Promise<void> {
  const userId = uid();
  if (!userId) return;
  try {
    await deleteDoc(doc(db, 'users', userId, 'saved_articles', safeId(articleId)));
  } catch {}
}

export async function syncReadingProgress(articleId: string): Promise<void> {
  const userId = uid();
  if (!userId) return;
  try {
    const dbMod = await import('../data/db');
    const row = await dbMod.getProgress(articleId);
    if (!row) return;
    await setDoc(doc(db, 'users', userId, 'reading_progress', safeId(articleId)), {
      article_id: articleId,
      pages_read: row.pages_read,
      total_pages: row.total_pages,
      scroll_depth: row.scroll_depth,
      completed: row.completed === 1,
      last_read_at: row.last_read_at,
    });
  } catch {}
}

export async function syncGoal(goal: number): Promise<void> {
  const userId = uid();
  if (!userId) return;
  try {
    await setDoc(doc(db, 'users', userId, 'settings', 'daily_goal'), { value: String(goal) });
  } catch {}
}

export async function syncDailyLog(date: string, qualifyingReads: number, pagesRead = 0): Promise<void> {
  const userId = uid();
  if (!userId) return;
  try {
    await setDoc(
      doc(db, 'users', userId, 'daily_log', date),
      { qualifying_reads: qualifyingReads, pages_read: pagesRead },
      { merge: true },
    );
  } catch {}
}

export async function syncHighlight(h: HighlightRow): Promise<void> {
  const userId = uid();
  if (!userId) return;
  try {
    await setDoc(doc(db, 'users', userId, 'highlights', `${safeId(h.article_id)}_${h.created_at}`), {
      article_id: h.article_id,
      selected_text: h.selected_text,
      color: h.color,
      created_at: h.created_at,
    });
  } catch {}
}

export async function syncDeleteHighlight(articleId: string, createdAt: number): Promise<void> {
  const userId = uid();
  if (!userId) return;
  try {
    await deleteDoc(doc(db, 'users', userId, 'highlights', `${safeId(articleId)}_${createdAt}`));
  } catch {}
}

export async function syncBook(book: BookRow, coverUrl?: string): Promise<void> {
  const userId = uid();
  if (!userId) return;
  try {
    await setDoc(doc(db, 'users', userId, 'books', book.id), {
      title: book.title, author: book.author, format: book.format,
      // cover_uri is a local path — store the original download URL instead
      cover_url: coverUrl ?? null,
      added_at: book.added_at, last_read_at: book.last_read_at ?? null,
      current_page: book.current_page, total_pages: book.total_pages,
    });
  } catch {}
}

export async function syncBookProgress(
  bookId: string, page: number, totalPages: number,
): Promise<void> {
  const userId = uid();
  if (!userId) return;
  try {
    await setDoc(doc(db, 'users', userId, 'books', bookId), {
      current_page: page, total_pages: totalPages, last_read_at: Date.now(),
      scroll_offset: 0,
    }, { merge: true });
  } catch {}
}

export async function syncBookScrollOffset(bookId: string, offset: number): Promise<void> {
  const userId = uid();
  if (!userId) return;
  try {
    await setDoc(doc(db, 'users', userId, 'books', bookId), {
      scroll_offset: offset,
    }, { merge: true });
  } catch {}
}

export async function syncDeleteBook(bookId: string): Promise<void> {
  const userId = uid();
  if (!userId) return;
  try { await deleteDoc(doc(db, 'users', userId, 'books', bookId)); } catch {}
}

export async function syncBookHighlight(h: BookHighlightRow): Promise<void> {
  const userId = uid();
  if (!userId) return;
  try {
    await setDoc(doc(db, 'users', userId, 'book_highlights', h.id), {
      book_id: h.book_id, page: h.page, cfi: h.cfi ?? null,
      selected_text: h.selected_text, color: h.color,
      note: h.note ?? null, created_at: h.created_at,
    });
  } catch {}
}

export async function syncDeleteBookHighlight(id: string): Promise<void> {
  const userId = uid();
  if (!userId) return;
  try { await deleteDoc(doc(db, 'users', userId, 'book_highlights', id)); } catch {}
}

// kept for API compat — no Supabase read events in Firebase
export async function syncReadEvent(
  _articleId: string, _secondsRead: number, _scrollDepth: number, _qualifying: boolean,
): Promise<void> {}

// ── Upload local → Firebase ───────────────────────────────────────────────────

export async function uploadLocalToSupabase(): Promise<void> {
  const userId = uid();
  if (!userId) return;

  const dbMod = await import('../data/db');
  const batch = writeBatch(db);
  let ops = 0;

  const flush = async () => {
    if (ops > 0) { await batch.commit(); ops = 0; }
  };

  try {
    const ids = await dbMod.getFollowedIds();
    for (const sourceId of ids) {
      batch.set(doc(db, 'users', userId, 'sources', sourceId), { source_id: sourceId });
      ops++;
    }
  } catch {}

  try {
    const remoteSrcs = await dbMod.getAllRemoteSources();
    for (const r of remoteSrcs) {
      batch.set(doc(db, 'users', userId, 'remote_sources', r.id), {
        name: r.name, feed_url: r.feed_url, description: r.description,
        color: r.color, added_at: r.added_at,
      });
      ops++;
    }
  } catch {}

  try {
    const savedArticles = await dbMod.getSavedArticles();
    for (const a of savedArticles) {
      batch.set(doc(db, 'users', userId, 'saved_articles', safeId(a.id)), {
        article_id: a.id, title: a.title, link: a.link,
        publication_id: a.publication_id, pub_date: a.pub_date,
        excerpt: a.excerpt ?? null, image_url: a.image_url ?? null,
        saved_at: Date.now(),
      });
      ops++;
    }
  } catch {}

  await flush();

  try {
    const rawDb = dbMod.getDb();
    const logs = await rawDb.getAllAsync<{ date: string; qualifying_reads: number; pages_read: number }>(
      `SELECT date, qualifying_reads, pages_read FROM daily_log`,
    );
    const b2 = writeBatch(db);
    for (const l of logs) {
      b2.set(doc(db, 'users', userId, 'daily_log', l.date), {
        qualifying_reads: l.qualifying_reads, pages_read: l.pages_read ?? 0,
      });
    }
    await b2.commit();
  } catch {}

  try {
    const highlights = await dbMod.getAllHighlights();
    const b3 = writeBatch(db);
    for (const h of highlights) {
      b3.set(doc(db, 'users', userId, 'highlights', `${safeId(h.article_id)}_${h.created_at}`), {
        article_id: h.article_id, selected_text: h.selected_text,
        color: h.color, created_at: h.created_at,
      });
    }
    await b3.commit();
  } catch {}

  try {
    const rawDb = dbMod.getDb();
    const progress = await rawDb.getAllAsync<{
      article_id: string; pages_read: number; total_pages: number;
      scroll_depth: number; completed: number; last_read_at: number;
    }>(`SELECT * FROM reading_progress`);
    const b4 = writeBatch(db);
    for (const p of progress) {
      b4.set(doc(db, 'users', userId, 'reading_progress', safeId(p.article_id)), {
        article_id: p.article_id, pages_read: p.pages_read, total_pages: p.total_pages,
        scroll_depth: p.scroll_depth ?? 0, completed: p.completed === 1, last_read_at: p.last_read_at,
      });
    }
    await b4.commit();
  } catch {}

  try {
    // Only push goal if user explicitly set it — avoids overwriting the cloud value with the
    // INSERT OR IGNORE default ('1') on a fresh install before restoreFromSupabase runs.
    const goalExplicit = await dbMod.getSetting('goal_explicitly_set');
    if (goalExplicit) {
      const goal = await dbMod.getDailyGoal();
      await setDoc(doc(db, 'users', userId, 'settings', 'daily_goal'), { value: String(goal) });
    }
  } catch {}

  // Book highlights — individual setDoc calls (IDs are stable strings, not integers)
  try {
    const rawDb = dbMod.getDb();
    const bHighlights = await rawDb.getAllAsync<{
      id: string; book_id: string; page: number; cfi: string | null;
      selected_text: string; color: string; note: string | null; created_at: number;
    }>(`SELECT * FROM book_highlights`);
    if (bHighlights.length > 0) {
      const b5 = writeBatch(db);
      for (const h of bHighlights) {
        b5.set(doc(db, 'users', userId, 'book_highlights', h.id), {
          book_id: h.book_id, page: h.page, cfi: h.cfi ?? null,
          selected_text: h.selected_text, color: h.color,
          note: h.note ?? null, created_at: h.created_at,
        });
      }
      await b5.commit();
    }
  } catch {}
}

// ── Restore ───────────────────────────────────────────────────────────────────

export async function restoreFromSupabase(): Promise<void> {
  const userId = uid();
  if (!userId) return;

  const dbMod = await import('../data/db');

  let restoredFollowCount = 0;

  // 1. Curated follows
  try {
    const snap = await getDocs(collection(db, 'users', userId, 'sources'));
    const rawDb = dbMod.getDb();
    for (const d of snap.docs) {
      const sourceId = (d.data().source_id as string) ?? d.id;
      await rawDb.runAsync(
        `INSERT OR IGNORE INTO followed_publications (id, followed_at) VALUES (?, ?)`,
        [sourceId, Date.now()],
      );
      restoredFollowCount++;
    }
  } catch {}

  // 2. Remote sources
  try {
    const snap = await getDocs(collection(db, 'users', userId, 'remote_sources'));
    for (const d of snap.docs) {
      const r = d.data();
      const src: RemoteSourceRow = {
        id: d.id,
        name: r.name, feed_url: r.feed_url, description: r.description ?? '',
        color: r.color ?? '#60A5FA', added_at: r.added_at ?? Date.now(),
      };
      await dbMod.upsertRemoteSource(src);
      const rawDb = dbMod.getDb();
      await rawDb.runAsync(
        `INSERT OR IGNORE INTO followed_publications (id, followed_at) VALUES (?, ?)`,
        [src.id, src.added_at],
      );
      restoredFollowCount++;
    }
  } catch {}

  if (restoredFollowCount > 0) {
    try { await dbMod.setSetting('onboarding_done', '1'); } catch {}
  }

  // 3. Saved articles
  try {
    const snap = await getDocs(collection(db, 'users', userId, 'saved_articles'));
    const articles: ArticleRow[] = [];
    const savedAts = new Map<string, number>();
    for (const d of snap.docs) {
      const s = d.data();
      if (!s.title) continue;
      articles.push({
        id: s.article_id, publication_id: s.publication_id,
        title: s.title, link: s.link, pub_date: s.pub_date ?? 0,
        excerpt: s.excerpt ?? null, content_html: null,
        image_url: s.image_url ?? null, word_count: null, fetched_at: Date.now(),
      });
      savedAts.set(s.article_id as string, (s.saved_at as number) ?? Date.now());
    }
    if (articles.length > 0) {
      await dbMod.upsertArticles(articles);
      const rawDb = dbMod.getDb();
      for (const a of articles) {
        await rawDb.runAsync(
          `INSERT OR IGNORE INTO saved_articles (article_id, saved_at) VALUES (?, ?)`,
          [a.id, savedAts.get(a.id) ?? Date.now()],
        );
      }
    }
  } catch {}

  // 4. Daily log
  try {
    const snap = await getDocs(collection(db, 'users', userId, 'daily_log'));
    const rawDb = dbMod.getDb();
    for (const d of snap.docs) {
      const l = d.data();
      await rawDb.runAsync(
        `INSERT INTO daily_log (date, qualifying_reads, pages_read) VALUES (?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET
           qualifying_reads = MAX(qualifying_reads, excluded.qualifying_reads),
           pages_read = MAX(pages_read, excluded.pages_read)`,
        [d.id, l.qualifying_reads, l.pages_read ?? 0],
      );
    }
  } catch {}

  // 5. Settings
  try {
    const goalSnap = await getDoc(doc(db, 'users', userId, 'settings', 'daily_goal'));
    if (goalSnap.exists()) {
      await dbMod.setSetting('daily_goal', goalSnap.data().value as string);
      // Mark as explicitly set so future uploadLocalToSupabase calls push the restored value
      await dbMod.setSetting('goal_explicitly_set', '1');
    }
  } catch {}

  // 6. Highlights
  try {
    const snap = await getDocs(collection(db, 'users', userId, 'highlights'));
    const rawDb = dbMod.getDb();
    for (const d of snap.docs) {
      const h = d.data();
      await rawDb.runAsync(
        `INSERT OR IGNORE INTO highlights (article_id, selected_text, color, created_at) VALUES (?, ?, ?, ?)`,
        [h.article_id, h.selected_text, h.color, h.created_at],
      );
    }
  } catch {}

  // 7. Book metadata + progress
  //    File stays local — restore metadata/progress so book shows in library.
  //    For books not on this device, insert a placeholder (file_uri='') so
  //    the BookshelfScreen shows them with the "file missing" banner.
  try {
    const booksMod = await import('../data/books');
    const snap = await getDocs(collection(db, 'users', userId, 'books'));
    for (const d of snap.docs) {
      const b = d.data();
      const existing = await booksMod.getBookById(d.id);
      if (existing) {
        if ((b.current_page ?? 0) > existing.current_page) {
          const rawDb = dbMod.getDb();
          await rawDb.runAsync(
            `UPDATE books SET current_page = ?, total_pages = ?, last_read_at = ?, scroll_offset = ? WHERE id = ?`,
            [b.current_page, b.total_pages, b.last_read_at ?? null, b.scroll_offset ?? 0, d.id],
          );
        } else if ((b.current_page ?? 0) === existing.current_page && (b.scroll_offset ?? 0) !== existing.scroll_offset) {
          // Same chapter — restore scroll position even if chapter hasn't advanced
          const rawDb = dbMod.getDb();
          await rawDb.runAsync(
            `UPDATE books SET scroll_offset = ? WHERE id = ?`,
            [b.scroll_offset ?? 0, d.id],
          );
        }
        // Re-download cover if cloud has a URL but local cover is gone
        if (b.cover_url && !existing.cover_uri) {
          try {
            const FS = await import('expo-file-system/legacy');
            const dir = ((FS as any).documentDirectory ?? '') + 'books/covers/';
            await (FS as any).makeDirectoryAsync(dir, { intermediates: true });
            const dest = dir + d.id + '_cover.jpg';
            const res = await (FS as any).downloadAsync(b.cover_url, dest);
            if (res.status === 200) await booksMod.updateBookCover(d.id, res.uri);
          } catch {}
        }
      } else {
        // Fresh install — create placeholder row; user re-imports the file
        await booksMod.upsertBook({
          id: d.id,
          title: b.title ?? 'Unknown',
          author: b.author ?? '',
          file_uri: '',                              // missing until re-imported
          format: (b.format ?? 'pdf') as import('../data/books').BookFormat,
          cover_uri: null,
          added_at: b.added_at ?? Date.now(),
          last_read_at: b.last_read_at ?? null,
          current_page: b.current_page ?? 0,
          total_pages: b.total_pages ?? 0,
          scroll_offset: b.scroll_offset ?? 0,
        });
        // Attempt to re-download cover from stored URL
        if (b.cover_url) {
          try {
            const FS = await import('expo-file-system/legacy');
            const dir = ((FS as any).documentDirectory ?? '') + 'books/covers/';
            await (FS as any).makeDirectoryAsync(dir, { intermediates: true });
            const dest = dir + d.id + '_cover.jpg';
            const res = await (FS as any).downloadAsync(b.cover_url, dest);
            if (res.status === 200) await booksMod.updateBookCover(d.id, res.uri);
          } catch {}
        }
      }
    }
  } catch {}

  // 8. Book highlights
  try {
    const booksMod = await import('../data/books');
    const snap = await getDocs(collection(db, 'users', userId, 'book_highlights'));
    for (const d of snap.docs) {
      const h = d.data();
      const rawDb = dbMod.getDb();
      await rawDb.runAsync(
        `INSERT OR IGNORE INTO book_highlights
           (id, book_id, page, cfi, selected_text, color, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.id, h.book_id, h.page ?? 0, h.cfi ?? null,
         h.selected_text, h.color, h.note ?? null, h.created_at],
      );
    }
    void booksMod; // suppress unused warning
  } catch {}

  // 9. Reading progress
  try {
    const snap = await getDocs(collection(db, 'users', userId, 'reading_progress'));
    const rawDb = dbMod.getDb();
    for (const d of snap.docs) {
      const p = d.data();
      await rawDb.runAsync(
        `INSERT INTO reading_progress (article_id, pages_read, total_pages, scroll_depth, completed, last_read_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(article_id) DO UPDATE SET
           pages_read = MAX(pages_read, excluded.pages_read),
           scroll_depth = MAX(scroll_depth, excluded.scroll_depth),
           completed = MAX(completed, excluded.completed),
           last_read_at = MAX(last_read_at, excluded.last_read_at)`,
        [p.article_id, p.pages_read, p.total_pages, p.scroll_depth ?? 0, p.completed ? 1 : 0, p.last_read_at],
      );
    }
  } catch {}
}
