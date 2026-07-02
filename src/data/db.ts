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
      qualifying_reads INTEGER NOT NULL DEFAULT 0
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

  await db.runAsync(`INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', '7')`);
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
    await db.runAsync(
      `INSERT OR REPLACE INTO articles
         (id, publication_id, title, link, pub_date, excerpt, content_html, image_url, word_count, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [a.id, a.publication_id, a.title, a.link, a.pub_date,
       a.excerpt ?? null, a.content_html ?? null, a.image_url ?? null, a.word_count ?? null, a.fetched_at],
    );
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
  completed: number;
  last_read_at: number;
}

export async function getProgress(articleId: string): Promise<ProgressRow | null> {
  const db = getDb();
  return db.getFirstAsync<ProgressRow>(`SELECT * FROM reading_progress WHERE article_id = ?`, [articleId]);
}

export async function recordPageRead(articleId: string, pagesRead: number, totalPages: number): Promise<void> {
  const db = getDb();
  const now = Date.now();
  const completed = pagesRead >= totalPages ? 1 : 0;

  await db.runAsync(
    `INSERT INTO reading_progress (article_id, pages_read, total_pages, completed, last_read_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(article_id) DO UPDATE SET
       pages_read = MAX(pages_read, excluded.pages_read),
       total_pages = excluded.total_pages,
       completed = excluded.completed,
       last_read_at = excluded.last_read_at`,
    [articleId, pagesRead, totalPages, completed, now],
  );
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
  return new Date().toISOString().slice(0, 10);
}

export async function getTodayReads(): Promise<number> {
  const db = getDb();
  const row = await db.getFirstAsync<{ qualifying_reads: number }>(
    `SELECT qualifying_reads FROM daily_log WHERE date = ?`, [todayKey()],
  );
  return row?.qualifying_reads ?? 0;
}

// Keep for backwards compat with StreakScreen/ProfileScreen
export async function getTodayPages(): Promise<number> {
  return getTodayReads();
}

export async function getDailyGoal(): Promise<number> {
  const val = await getSetting('daily_goal');
  return parseInt(val ?? '1', 10);
}

export async function setDailyGoal(n: number): Promise<void> {
  await setSetting('daily_goal', String(n));
}

export async function computeStreak(): Promise<number> {
  const db = getDb();
  const goal = await getDailyGoal();
  const rows = await db.getAllAsync<{ date: string; qualifying_reads: number }>(
    `SELECT date, qualifying_reads FROM daily_log ORDER BY date DESC`,
  );
  if (rows.length === 0) return 0;

  let streak = 0;
  let cursor = new Date(todayKey());

  for (const row of rows) {
    const expected = cursor.toISOString().slice(0, 10);
    if (row.date === expected && row.qualifying_reads >= goal) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else if (row.date < expected) {
      break;
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
  await db.runAsync(
    `INSERT OR REPLACE INTO remote_sources (id, name, feed_url, description, color, added_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [src.id, src.name, src.feed_url, src.description, src.color, src.added_at],
  );
  cacheRemoteMeta(src.id, src.name, src.color, src.feed_url);
  // Persist metadata to Supabase so remote follows survive reinstall
  import('../lib/sync').then((m) => m.syncRemoteSource(src)).catch(() => {});
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

export async function deleteHighlight(id: number): Promise<void> {
  const db = getDb();
  const row = await db.getFirstAsync<HighlightRow>(`SELECT * FROM highlights WHERE id = ?`, [id]);
  await db.runAsync(`DELETE FROM highlights WHERE id = ?`, [id]);
  if (row) {
    import('../lib/sync').then((m) => m.syncDeleteHighlight(row.article_id, row.created_at)).catch(() => {});
  }
}
