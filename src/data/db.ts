import * as SQLite from 'expo-sqlite';

let _db: SQLite.SQLiteDatabase | null = null;

export function getDb(): SQLite.SQLiteDatabase {
  if (!_db) _db = SQLite.openDatabaseSync('perch.db');
  return _db;
}

export async function initDb(): Promise<void> {
  const db = getDb();

  // v3: adds saved_articles + read_events tables; wipes stale article cache
  const ver = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'db_version'`,
  ).catch(() => null);

  const verNum = ver ? Number(ver.value) : 0;

  if (verNum < 3) {
    await db.execAsync(
      `DROP TABLE IF EXISTS articles;
       DROP TABLE IF EXISTS reading_progress;
       DROP TABLE IF EXISTS daily_log;
       DROP TABLE IF EXISTS saved_articles;
       DROP TABLE IF EXISTS read_events;`,
    );
  }

  await db.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS followed_publications (
      id TEXT PRIMARY KEY,
      followed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      publication_id TEXT NOT NULL,
      title TEXT NOT NULL,
      link TEXT NOT NULL,
      pub_date INTEGER NOT NULL,
      excerpt TEXT,
      content_html TEXT,
      image_url TEXT,
      word_count INTEGER,
      fetched_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reading_progress (
      article_id TEXT PRIMARY KEY,
      pages_read INTEGER NOT NULL DEFAULT 0,
      total_pages INTEGER NOT NULL DEFAULT 1,
      completed INTEGER NOT NULL DEFAULT 0,
      last_read_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS saved_articles (
      article_id TEXT PRIMARY KEY,
      saved_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS read_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id TEXT NOT NULL,
      seconds_read INTEGER NOT NULL DEFAULT 0,
      scroll_depth REAL NOT NULL DEFAULT 0,
      qualifying INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_log (
      date TEXT PRIMARY KEY,
      qualifying_reads INTEGER NOT NULL DEFAULT 0,
      pages_read INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS remote_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      feed_url TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#60A5FA',
      added_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS highlights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id TEXT NOT NULL,
      selected_text TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#C8AA6E',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      file_uri TEXT NOT NULL,
      format TEXT NOT NULL,
      cover_uri TEXT,
      added_at INTEGER NOT NULL,
      last_read_at INTEGER,
      current_page INTEGER NOT NULL DEFAULT 0,
      total_pages INTEGER NOT NULL DEFAULT 0,
      scroll_offset REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS book_highlights (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      page INTEGER NOT NULL DEFAULT 0,
      cfi TEXT,
      selected_text TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#C8AA6E',
      note TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  await db.runAsync(`INSERT OR IGNORE INTO settings (key, value) VALUES ('daily_goal', '1')`);
  await db.runAsync(`INSERT OR IGNORE INTO settings (key, value) VALUES ('onboarding_done', '0')`);

  // v4: additive migration — add image_url column without dropping data
  if (verNum >= 3 && verNum < 4) {
    try { await db.execAsync(`ALTER TABLE articles ADD COLUMN image_url TEXT`); } catch {}
  }

  // v7: unique index on highlights so INSERT OR IGNORE works during Supabase restore
  if (verNum < 7) {
    try { await db.execAsync(`CREATE UNIQUE INDEX IF NOT EXISTS idx_highlights_dedup ON highlights(article_id, created_at)`); } catch {}
  }

  // v8: add scroll_depth to reading_progress for scroll-mode progress tracking
  if (verNum < 8) {
    try { await db.execAsync(`ALTER TABLE reading_progress ADD COLUMN scroll_depth REAL NOT NULL DEFAULT 0`); } catch {}
  }

  // v9: add pages_read to daily_log for page-based goal tracking
  if (verNum < 9) {
    try { await db.execAsync(`ALTER TABLE daily_log ADD COLUMN pages_read INTEGER NOT NULL DEFAULT 0`); } catch {}
  }

  // v10: add website_url to remote_sources for Feedburner/redirect feed fallback scraping
  if (verNum < 10) {
    try { await db.execAsync(`ALTER TABLE remote_sources ADD COLUMN website_url TEXT`); } catch {}
  }

  // v11: books + book_highlights tables (handled by CREATE TABLE IF NOT EXISTS above)
  // Nothing extra needed — tables are created fresh or already exist.

  // v12: mark existing users who have an explicit (non-default) daily goal
  if (verNum < 12) {
    try {
      const existingGoal = await db.getFirstAsync<{ value: string }>(
        `SELECT value FROM settings WHERE key = 'daily_goal'`,
      );
      if (existingGoal && existingGoal.value !== '1') {
        await db.runAsync(`INSERT OR IGNORE INTO settings (key, value) VALUES ('goal_explicitly_set', '1')`);
      }
    } catch {}
  }

  // v13: add scroll_offset to books for per-chapter scroll position restore
  if (verNum < 13) {
    try { await db.execAsync(`ALTER TABLE books ADD COLUMN scroll_offset REAL NOT NULL DEFAULT 0`); } catch {}
  }

  // v14: upgrade http:// feed URLs in remote_sources to https:// (fixes Feedly-sourced feeds
  //       like the Guardian that use the old guardian.co.uk HTTP domain)
  if (verNum < 14) {
    try {
      await db.execAsync(
        `UPDATE remote_sources SET feed_url = 'https://' || SUBSTR(feed_url, 8)
         WHERE feed_url LIKE 'http://%'`,
      );
    } catch {}
  }

  await db.runAsync(`INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', '14')`);
}

// --- Settings helpers ---

export async function getSetting(key: string): Promise<string | null> {
  const db = getDb();
  const row = await db.getFirstAsync<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, [key]);
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = getDb();
  await db.runAsync(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key, value]);
}

// --- Followed publications ---

export async function followPublication(id: string): Promise<void> {
  const db = getDb();
  await db.runAsync(`INSERT OR IGNORE INTO followed_publications (id, followed_at) VALUES (?, ?)`, [id, Date.now()]);
  import('../lib/sync').then((m) => m.syncFollow(id)).catch(() => {});
}

export async function unfollowPublication(id: string): Promise<void> {
  const db = getDb();
  await db.runAsync(`DELETE FROM followed_publications WHERE id = ?`, [id]);
  await db.runAsync(`DELETE FROM remote_sources WHERE id = ?`, [id]);
  import('../lib/sync').then((m) => m.syncUnfollow(id)).catch(() => {});
}

export async function getFollowedIds(): Promise<string[]> {
  const db = getDb();
  const rows = await db.getAllAsync<{ id: string }>(`SELECT id FROM followed_publications ORDER BY followed_at`);
  return rows.map((r) => r.id);
}

// --- Articles ---

export interface ArticleRow {
  id: string;
  publication_id: string;
  title: string;
  link: string;
  pub_date: number;
  excerpt: string | null;
  content_html: string | null;
  image_url: string | null;
  word_count: number | null;
  fetched_at: number;
}

export async function upsertArticles(articles: ArticleRow[]): Promise<void> {
  const db = getDb();
  for (const a of articles) {
    try {
      await db.runAsync(
        `INSERT OR REPLACE INTO articles
           (id, publication_id, title, link, pub_date, excerpt, content_html, image_url, word_count, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [a.id, a.publication_id, a.title, a.link, a.pub_date,
         a.excerpt ?? null, a.content_html ?? null, a.image_url ?? null, a.word_count ?? null, a.fetched_at],
      );
    } catch {}
  }
}

export async function getArticlesForPublications(pubIds: string[]): Promise<ArticleRow[]> {
  if (pubIds.length === 0) return [];
  const db = getDb();
  const ph = pubIds.map(() => '?').join(',');
  return db.getAllAsync<ArticleRow>(
    `SELECT * FROM articles WHERE publication_id IN (${ph}) ORDER BY pub_date DESC`,
    pubIds,
  );
}

export async function getArticleById(id: string): Promise<ArticleRow | null> {
  const db = getDb();
  return db.getFirstAsync<ArticleRow>(`SELECT * FROM articles WHERE id = ?`, [id]);
}

export async function updateArticleWordCount(id: string, wordCount: number): Promise<void> {
  const db = getDb();
  await db.runAsync(`UPDATE articles SET word_count = ? WHERE id = ?`, [wordCount, id]);
}

// --- Reading progress ---

export interface ProgressRow {
  article_id: string;
  pages_read: number;
  total_pages: number;
  scroll_depth: number;
  completed: number;
  last_read_at: number;
}

export async function getProgress(articleId: string): Promise<ProgressRow | null> {
  const db = getDb();
  return db.getFirstAsync<ProgressRow>(`SELECT * FROM reading_progress WHERE article_id = ?`, [articleId]);
}

export async function getProgressBatch(articleIds: string[]): Promise<Map<string, number>> {
  if (articleIds.length === 0) return new Map();
  const db = getDb();
  const ph = articleIds.map(() => '?').join(',');
  const rows = await db.getAllAsync<ProgressRow>(
    `SELECT * FROM reading_progress WHERE article_id IN (${ph})`,
    articleIds,
  );
  return new Map(rows.map((r) => [
    r.article_id,
    r.completed ? 1 : Math.max(r.pages_read / r.total_pages, r.scroll_depth ?? 0),
  ]));
}

export async function recordPageRead(articleId: string, pagesRead: number, totalPages: number): Promise<void> {
  const db = getDb();
  const now = Date.now();
  const completed = pagesRead >= totalPages ? 1 : 0;

  // Compute new pages read since last record so we can add to today's daily total
  const prev = await db.getFirstAsync<{ pages_read: number }>(
    `SELECT pages_read FROM reading_progress WHERE article_id = ?`, [articleId],
  );
  const delta = Math.max(0, pagesRead - (prev?.pages_read ?? 0));

  await db.runAsync(
    `INSERT INTO reading_progress (article_id, pages_read, total_pages, scroll_depth, completed, last_read_at)
     VALUES (?, ?, ?, 0, ?, ?)
     ON CONFLICT(article_id) DO UPDATE SET
       pages_read = MAX(pages_read, excluded.pages_read),
       total_pages = excluded.total_pages,
       completed = excluded.completed,
       last_read_at = excluded.last_read_at`,
    [articleId, pagesRead, totalPages, completed, now],
  );

  if (delta > 0) {
    const key = todayKey();
    await db.runAsync(
      `INSERT INTO daily_log (date, qualifying_reads, pages_read) VALUES (?, 0, ?)
       ON CONFLICT(date) DO UPDATE SET pages_read = pages_read + excluded.pages_read`,
      [key, delta],
    );
    const row = await db.getFirstAsync<{ qualifying_reads: number; pages_read: number }>(
      `SELECT qualifying_reads, pages_read FROM daily_log WHERE date = ?`, [key],
    );
    if (row) {
      import('../lib/sync').then((m) => m.syncDailyLog(key, row.qualifying_reads, row.pages_read)).catch(() => {});
    }
  }

  import('../lib/sync').then((m) => m.syncReadingProgress(articleId)).catch(() => {});
}

export async function recordScrollProgress(articleId: string, depth: number): Promise<void> {
  const db = getDb();
  const now = Date.now();
  const completed = depth >= 0.9 ? 1 : 0;

  // Check prior state so we only increment daily pages once per article completion
  const prev = await db.getFirstAsync<{ completed: number }>(
    `SELECT completed FROM reading_progress WHERE article_id = ?`, [articleId],
  );
  const wasCompleted = prev?.completed ?? 0;

  await db.runAsync(
    `INSERT INTO reading_progress (article_id, pages_read, total_pages, scroll_depth, completed, last_read_at)
     VALUES (?, 0, 1, ?, ?, ?)
     ON CONFLICT(article_id) DO UPDATE SET
       scroll_depth = MAX(scroll_depth, excluded.scroll_depth),
       completed = MAX(completed, excluded.completed),
       last_read_at = excluded.last_read_at`,
    [articleId, depth, completed, now],
  );

  // Count one page toward the daily goal the first time a scroll-mode article is completed
  if (completed && !wasCompleted) {
    const key = todayKey();
    await db.runAsync(
      `INSERT INTO daily_log (date, qualifying_reads, pages_read) VALUES (?, 0, 1)
       ON CONFLICT(date) DO UPDATE SET pages_read = pages_read + 1`,
      [key],
    );
    const row = await db.getFirstAsync<{ qualifying_reads: number; pages_read: number }>(
      `SELECT qualifying_reads, pages_read FROM daily_log WHERE date = ?`, [key],
    );
    if (row) {
      import('../lib/sync').then((m) => m.syncDailyLog(key, row.qualifying_reads, row.pages_read)).catch(() => {});
    }
  }

  import('../lib/sync').then((m) => m.syncReadingProgress(articleId)).catch(() => {});
}

// --- Read events (PRD: 60% scroll depth OR 90s active reading = qualifying) ---

export async function logReadEvent(
  articleId: string,
  secondsRead: number,
  scrollDepth: number,
): Promise<void> {
  const db = getDb();
  const qualifying = secondsRead >= 90 || scrollDepth >= 0.6 ? 1 : 0;
  await db.runAsync(
    `INSERT INTO read_events (article_id, seconds_read, scroll_depth, qualifying, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [articleId, secondsRead, scrollDepth, qualifying, Date.now()],
  );
  if (qualifying) {
    await incrementDailyLog();
  }
  import('../lib/sync').then((m) =>
    m.syncReadEvent(articleId, secondsRead, scrollDepth, qualifying === 1)
  ).catch(() => {});
}

async function incrementDailyLog(): Promise<void> {
  const db = getDb();
  const key = todayKey();
  await db.runAsync(
    `INSERT INTO daily_log (date, qualifying_reads) VALUES (?, 1)
     ON CONFLICT(date) DO UPDATE SET qualifying_reads = qualifying_reads + 1`,
    [key],
  );
  // Read the FULL row so pages_read isn't overwritten to 0 in Firestore
  const row = await db.getFirstAsync<{ qualifying_reads: number; pages_read: number }>(
    `SELECT qualifying_reads, pages_read FROM daily_log WHERE date = ?`, [key],
  );
  if (row) {
    import('../lib/sync').then((m) => m.syncDailyLog(key, row.qualifying_reads, row.pages_read ?? 0)).catch(() => {});
  }
}

// --- Saved articles ---

export async function saveArticle(articleId: string): Promise<void> {
  const db = getDb();
  await db.runAsync(
    `INSERT OR IGNORE INTO saved_articles (article_id, saved_at) VALUES (?, ?)`,
    [articleId, Date.now()],
  );
  // Sync ID + full article payload so Library survives reinstall
  const article = await getArticleById(articleId);
  import('../lib/sync').then((m) => {
    m.syncSave(articleId).catch(() => {});
    if (article) m.syncSaveArticle(article).catch(() => {});
  }).catch(() => {});
}

export async function unsaveArticle(articleId: string): Promise<void> {
  const db = getDb();
  await db.runAsync(`DELETE FROM saved_articles WHERE article_id = ?`, [articleId]);
  import('../lib/sync').then((m) => m.syncUnsave(articleId)).catch(() => {});
}

export async function isArticleSaved(articleId: string): Promise<boolean> {
  const db = getDb();
  const row = await db.getFirstAsync(`SELECT 1 FROM saved_articles WHERE article_id = ?`, [articleId]);
  return !!row;
}

export async function getSavedIds(): Promise<Set<string>> {
  const db = getDb();
  const rows = await db.getAllAsync<{ article_id: string }>(`SELECT article_id FROM saved_articles`);
  return new Set(rows.map((r) => r.article_id));
}

export async function getSavedArticles(): Promise<ArticleRow[]> {
  const db = getDb();
  return db.getAllAsync<ArticleRow>(
    `SELECT a.* FROM articles a
     INNER JOIN saved_articles s ON a.id = s.article_id
     ORDER BY s.saved_at DESC`,
  );
}

export async function getRecentlyRead(): Promise<ArticleRow[]> {
  const db = getDb();
  return db.getAllAsync<ArticleRow>(
    `SELECT a.* FROM articles a
     INNER JOIN reading_progress p ON a.id = p.article_id
     ORDER BY p.last_read_at DESC
     LIMIT 30`,
  );
}

// --- Streak ---

function todayKey(): string {
  const d = new Date();
  // Use local calendar date, not UTC — avoids off-by-one for non-UTC users
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function getTodayReads(): Promise<number> {
  const db = getDb();
  const row = await db.getFirstAsync<{ qualifying_reads: number }>(
    `SELECT qualifying_reads FROM daily_log WHERE date = ?`, [todayKey()],
  );
  return row?.qualifying_reads ?? 0;
}

export async function logBookPages(delta: number): Promise<void> {
  if (delta <= 0) return;
  const db = getDb();
  const key = todayKey();
  await db.runAsync(
    `INSERT INTO daily_log (date, qualifying_reads, pages_read) VALUES (?, 0, ?)
     ON CONFLICT(date) DO UPDATE SET pages_read = pages_read + excluded.pages_read`,
    [key, delta],
  );
  const row = await db.getFirstAsync<{ qualifying_reads: number; pages_read: number }>(
    `SELECT qualifying_reads, pages_read FROM daily_log WHERE date = ?`, [key],
  );
  if (row) {
    import('../lib/sync').then((m) => m.syncDailyLog(key, row.qualifying_reads, row.pages_read)).catch(() => {});
  }
}

export async function getTodayPages(): Promise<number> {
  const db = getDb();
  const row = await db.getFirstAsync<{ pages_read: number; qualifying_reads: number }>(
    `SELECT pages_read, qualifying_reads FROM daily_log WHERE date = ?`, [todayKey()],
  );
  return Math.max(row?.pages_read ?? 0, row?.qualifying_reads ?? 0);
}

export async function getDailyGoal(): Promise<number> {
  const val = await getSetting('daily_goal');
  return parseInt(val ?? '5', 10);
}

export async function setDailyGoal(n: number): Promise<void> {
  await setSetting('daily_goal', String(n));
  // Mark as explicitly set so uploadLocalToSupabase knows to push it (not the INSERT OR IGNORE default)
  await setSetting('goal_explicitly_set', '1');
  import('../lib/sync').then((m) => m.syncGoal(n)).catch(() => {});
}

export async function getDailyLogHistory(days: number): Promise<{ date: string; pages: number }[]> {
  const db = getDb();
  const rows = await db.getAllAsync<{ date: string; pages_read: number; qualifying_reads: number }>(
    `SELECT date, pages_read, qualifying_reads FROM daily_log ORDER BY date ASC`,
  );
  // Use qualifying_reads as a fallback for days that predate the pages_read tracking fix
  const map = new Map(rows.map((r) => [r.date, Math.max(r.pages_read, r.qualifying_reads)]));
  const result: { date: string; pages: number }[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    result.push({ date: key, pages: map.get(key) ?? 0 });
  }
  return result;
}

export async function computeStreak(): Promise<number> {
  const db = getDb();
  const goal = await getDailyGoal();
  const todayStr = todayKey();

  const rows = await db.getAllAsync<{ date: string; pages_read: number; qualifying_reads: number }>(
    `SELECT date, pages_read, qualifying_reads FROM daily_log ORDER BY date DESC`,
  );
  if (rows.length === 0) return 0;

  // A day counts if pages_read >= goal OR qualifying_reads >= goal (covers scroll-mode reads)
  const metDates = new Set(
    rows
      .filter((r) => r.pages_read >= goal || r.qualifying_reads >= goal)
      .map((r) => r.date),
  );

  // If today's goal isn't met yet, start counting from yesterday (streak still alive today)
  const cursor = new Date(todayStr);
  if (!metDates.has(todayStr)) cursor.setDate(cursor.getDate() - 1);

  let streak = 0;
  for (let i = 0; i < 1000; i++) {
    const key = cursor.toISOString().slice(0, 10);
    if (metDates.has(key)) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

// --- Remote sources (dynamically followed feeds, e.g. from Feedly search) ---

export interface RemoteSourceRow {
  id: string;
  name: string;
  feed_url: string;
  description: string;
  color: string;
  added_at: number;
  website_url?: string | null;
}

// In-memory cache so card renders can look up remote pub metadata synchronously.
const _remoteMetaCache = new Map<string, { name: string; color: string; feedUrl: string }>();

export function cacheRemoteMeta(id: string, name: string, color: string, feedUrl: string): void {
  _remoteMetaCache.set(id, { name, color, feedUrl });
}

export function getRemoteMetaSync(id: string): { name: string; color: string; feedUrl: string } | null {
  return _remoteMetaCache.get(id) ?? null;
}

export async function upsertRemoteSource(src: RemoteSourceRow): Promise<void> {
  const db = getDb();
  // Normalize http:// feed URLs to https:// — Feedly returns old http:// feed IDs
  // (e.g. feed/http://www.guardian.co.uk/...) which fail on Android release builds
  const normalizedSrc: RemoteSourceRow = {
    ...src,
    feed_url: src.feed_url.startsWith('http://') ? src.feed_url.replace('http://', 'https://') : src.feed_url,
  };
  await db.runAsync(
    `INSERT OR REPLACE INTO remote_sources (id, name, feed_url, description, color, added_at, website_url)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [normalizedSrc.id, normalizedSrc.name, normalizedSrc.feed_url, normalizedSrc.description, normalizedSrc.color, normalizedSrc.added_at, normalizedSrc.website_url ?? null],
  );
  cacheRemoteMeta(normalizedSrc.id, normalizedSrc.name, normalizedSrc.color, normalizedSrc.feed_url);
  // Persist metadata to Firestore so remote follows survive reinstall
  import('../lib/sync').then((m) => m.syncRemoteSource(normalizedSrc)).catch(() => {});
}

export async function getAllRemoteSources(): Promise<RemoteSourceRow[]> {
  const db = getDb();
  const rows = await db.getAllAsync<RemoteSourceRow>(
    `SELECT * FROM remote_sources ORDER BY added_at DESC`,
  );
  for (const r of rows) cacheRemoteMeta(r.id, r.name, r.color, r.feed_url);
  return rows;
}

// ── Highlights ────────────────────────────────────────────────────────────────

export interface HighlightRow {
  id: number;
  article_id: string;
  selected_text: string;
  color: string;
  created_at: number;
}

export async function saveHighlight(
  articleId: string,
  selectedText: string,
  color: string,
): Promise<number> {
  const db = getDb();
  const createdAt = Date.now();
  const result = await db.runAsync(
    `INSERT INTO highlights (article_id, selected_text, color, created_at) VALUES (?, ?, ?, ?)`,
    [articleId, selectedText, color, createdAt],
  );
  const newId = result.lastInsertRowId;
  import('../lib/sync').then((m) => m.syncHighlight({ id: newId, article_id: articleId, selected_text: selectedText, color, created_at: createdAt })).catch(() => {});
  return newId;
}

export async function getHighlightsForArticle(articleId: string): Promise<HighlightRow[]> {
  const db = getDb();
  return db.getAllAsync<HighlightRow>(
    `SELECT * FROM highlights WHERE article_id = ? ORDER BY created_at ASC`,
    [articleId],
  );
}

export async function getAllHighlights(): Promise<(HighlightRow & { article_title: string | null; article_link: string | null })[]> {
  const db = getDb();
  return db.getAllAsync(
    `SELECT h.*, a.title AS article_title, a.link AS article_link
     FROM highlights h
     LEFT JOIN articles a ON h.article_id = a.id
     ORDER BY h.created_at DESC`,
  );
}

export interface ReadHistoryRow {
  article_id: string;
  title: string | null;
  link: string | null;
  publication_id: string | null;
  pages_read: number;
  total_pages: number;
  scroll_depth: number;
  completed: number;
  last_read_at: number;
}

export async function getReadHistory(): Promise<ReadHistoryRow[]> {
  const db = getDb();
  return db.getAllAsync<ReadHistoryRow>(`
    SELECT
      rp.article_id, a.title, a.link, a.publication_id,
      rp.pages_read, rp.total_pages, rp.scroll_depth,
      rp.completed, rp.last_read_at
    FROM reading_progress rp
    LEFT JOIN articles a ON rp.article_id = a.id
    ORDER BY rp.last_read_at DESC
    LIMIT 200
  `);
}

export async function deleteHighlight(id: number): Promise<void> {
  const db = getDb();
  const row = await db.getFirstAsync<HighlightRow>(`SELECT * FROM highlights WHERE id = ?`, [id]);
  await db.runAsync(`DELETE FROM highlights WHERE id = ?`, [id]);
  if (row) {
    import('../lib/sync').then((m) => m.syncDeleteHighlight(row.article_id, row.created_at)).catch(() => {});
  }
}
