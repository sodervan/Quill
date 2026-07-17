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

    -- Muting a publication keeps it followed (still tracked, still shows in "following"
    -- counts) but suppresses its articles from the feed — distinct from unfollow (fully
    -- removes it) and from per-article "hide" (session-only, cleared on refresh).
    CREATE TABLE IF NOT EXISTS muted_publications (
      id TEXT PRIMARY KEY,
      muted_at INTEGER NOT NULL
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
      pages_read INTEGER NOT NULL DEFAULT 0,
      reading_seconds INTEGER NOT NULL DEFAULT 0
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

  // v15: add reading_seconds to daily_log (syncable aggregate) and backfill it from the
  //      existing local read_events log, which was never synced to the cloud
  if (verNum < 15) {
    try { await db.execAsync(`ALTER TABLE daily_log ADD COLUMN reading_seconds INTEGER NOT NULL DEFAULT 0`); } catch {}
    try {
      await db.execAsync(`
        INSERT OR IGNORE INTO daily_log (date, qualifying_reads, pages_read, reading_seconds)
        SELECT DISTINCT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime'), 0, 0, 0
        FROM read_events;

        UPDATE daily_log SET reading_seconds = (
          SELECT COALESCE(SUM(re.seconds_read), 0) FROM read_events re
          WHERE strftime('%Y-%m-%d', re.created_at / 1000, 'unixepoch', 'localtime') = daily_log.date
        );
      `);
    } catch {}
  }

  // v16: track book-only pages/seconds alongside the existing combined (article+book)
  //      daily_log columns, so stat cards can show an articles-vs-books breakdown
  //      without changing what already feeds the daily goal.
  if (verNum < 16) {
    try { await db.execAsync(`ALTER TABLE daily_log ADD COLUMN book_pages_read INTEGER NOT NULL DEFAULT 0`); } catch {}
    try { await db.execAsync(`ALTER TABLE daily_log ADD COLUMN book_reading_seconds INTEGER NOT NULL DEFAULT 0`); } catch {}
  }

  await db.runAsync(`INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', '16')`);
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

// --- Account switching ---
// The local SQLite DB is a single unscoped cache — it doesn't inherently know which
// account's data it holds. synced_uid records whose data is currently cached locally,
// so that signing into a DIFFERENT account can detect the mismatch and wipe the stale
// cache first, instead of uploading one account's reading history into another's.

export async function getSyncedUid(): Promise<string | null> {
  return getSetting('synced_uid');
}

export async function setSyncedUid(uid: string): Promise<void> {
  await setSetting('synced_uid', uid);
}

export async function resetLocalUserData(): Promise<void> {
  const db = getDb();
  await db.execAsync(`
    DELETE FROM daily_log;
    DELETE FROM reading_progress;
    DELETE FROM read_events;
    DELETE FROM highlights;
    DELETE FROM book_highlights;
    DELETE FROM books;
    DELETE FROM saved_articles;
    DELETE FROM followed_publications;
    DELETE FROM remote_sources;
    DELETE FROM articles;
  `);
  await setSetting('daily_goal', '1');
  await setSetting('goal_explicitly_set', '0');
  await setSetting('onboarding_done', '0');
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

// --- Muted publications (stays followed, but its articles are suppressed from the feed) ---

export async function mutePublication(id: string): Promise<void> {
  const db = getDb();
  await db.runAsync(`INSERT OR IGNORE INTO muted_publications (id, muted_at) VALUES (?, ?)`, [id, Date.now()]);
  import('../lib/sync').then((m) => m.syncMute(id)).catch(() => {});
}

export async function unmutePublication(id: string): Promise<void> {
  const db = getDb();
  await db.runAsync(`DELETE FROM muted_publications WHERE id = ?`, [id]);
  import('../lib/sync').then((m) => m.syncUnmute(id)).catch(() => {});
}

export async function getMutedIds(): Promise<string[]> {
  const db = getDb();
  const rows = await db.getAllAsync<{ id: string }>(`SELECT id FROM muted_publications`);
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
    await syncDailyLogRow(key);
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
    await syncDailyLogRow(key);
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
  // Always accrue reading time (for the "Time reading" stat); qualifying_reads only
  // increments when this session met the qualifying bar.
  await incrementDailyLog(qualifying, secondsRead);
  import('../lib/sync').then((m) =>
    m.syncReadEvent(articleId, secondsRead, scrollDepth, qualifying === 1)
  ).catch(() => {});
}

async function incrementDailyLog(qualifying: number, secondsRead: number): Promise<void> {
  const db = getDb();
  const key = todayKey();
  await db.runAsync(
    `INSERT INTO daily_log (date, qualifying_reads, pages_read, reading_seconds) VALUES (?, ?, 0, ?)
     ON CONFLICT(date) DO UPDATE SET
       qualifying_reads = qualifying_reads + excluded.qualifying_reads,
       reading_seconds = reading_seconds + excluded.reading_seconds`,
    [key, qualifying, secondsRead],
  );
  await syncDailyLogRow(key);
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
    `INSERT INTO daily_log (date, qualifying_reads, pages_read, book_pages_read) VALUES (?, 0, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       pages_read = pages_read + excluded.pages_read,
       book_pages_read = book_pages_read + excluded.book_pages_read`,
    [key, delta, delta],
  );
  await syncDailyLogRow(key);
}

/** Book-reading equivalent of logReadEvent — accrues into the same combined
 *  reading_seconds the "Read Today" stat already shows, plus a book-only column
 *  so the stat card can break the total down into articles vs books. */
export async function logBookReadEvent(secondsRead: number): Promise<void> {
  if (secondsRead <= 0) return;
  const db = getDb();
  const key = todayKey();
  await db.runAsync(
    `INSERT INTO daily_log (date, qualifying_reads, pages_read, reading_seconds, book_reading_seconds)
     VALUES (?, 0, 0, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       reading_seconds = reading_seconds + excluded.reading_seconds,
       book_reading_seconds = book_reading_seconds + excluded.book_reading_seconds`,
    [key, secondsRead, secondsRead],
  );
  await syncDailyLogRow(key);
}

async function syncDailyLogRow(key: string): Promise<void> {
  const db = getDb();
  const row = await db.getFirstAsync<{
    qualifying_reads: number; pages_read: number; reading_seconds: number;
    book_pages_read: number; book_reading_seconds: number;
  }>(
    `SELECT qualifying_reads, pages_read, reading_seconds, book_pages_read, book_reading_seconds
     FROM daily_log WHERE date = ?`, [key],
  );
  if (row) {
    import('../lib/sync').then((m) =>
      m.syncDailyLog(
        key, row.qualifying_reads, row.pages_read, row.reading_seconds ?? 0,
        row.book_pages_read ?? 0, row.book_reading_seconds ?? 0,
      )
    ).catch(() => {});
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

export async function computeBestStreak(): Promise<number> {
  const db = getDb();
  const goal = await getDailyGoal();

  const rows = await db.getAllAsync<{ date: string; pages_read: number; qualifying_reads: number }>(
    `SELECT date, pages_read, qualifying_reads FROM daily_log ORDER BY date ASC`,
  );
  const metDates = rows
    .filter((r) => r.pages_read >= goal || r.qualifying_reads >= goal)
    .map((r) => r.date);
  if (metDates.length === 0) return 0;

  let best = 1;
  let current = 1;
  for (let i = 1; i < metDates.length; i++) {
    const prev = new Date(metDates[i - 1]);
    const cur = new Date(metDates[i]);
    const dayDiff = Math.round((cur.getTime() - prev.getTime()) / 86400000);
    current = dayDiff === 1 ? current + 1 : 1;
    best = Math.max(best, current);
  }
  return best;
}

export async function getArticlesReadCount(): Promise<number> {
  const db = getDb();
  const row = await db.getFirstAsync<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM reading_progress WHERE completed = 1`,
  );
  return row?.cnt ?? 0;
}

export async function getTotalReadingSeconds(): Promise<number> {
  const db = getDb();
  // Sums the synced daily_log aggregate, not read_events directly — read_events is a
  // local-only raw log, while reading_seconds on daily_log is what round-trips through
  // restoreFromSupabase and survives reinstalls.
  const row = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(reading_seconds), 0) as total FROM daily_log`,
  );
  return row?.total ?? 0;
}

export async function getTodayReadingSeconds(): Promise<number> {
  const db = getDb();
  const row = await db.getFirstAsync<{ reading_seconds: number }>(
    `SELECT reading_seconds FROM daily_log WHERE date = ?`, [todayKey()],
  );
  return row?.reading_seconds ?? 0;
}

/** Splits today's combined pages/seconds totals into articles-vs-books, for the
 *  expandable "Pages today" / "Read today" stat cards. */
export async function getTodayStatsBreakdown(): Promise<{
  articleSeconds: number; bookSeconds: number; articlePages: number; bookPages: number;
}> {
  const db = getDb();
  const row = await db.getFirstAsync<{
    pages_read: number; reading_seconds: number; book_pages_read: number; book_reading_seconds: number;
  }>(
    `SELECT pages_read, reading_seconds, book_pages_read, book_reading_seconds FROM daily_log WHERE date = ?`,
    [todayKey()],
  );
  const bookPages = row?.book_pages_read ?? 0;
  const bookSeconds = row?.book_reading_seconds ?? 0;
  return {
    articlePages: Math.max(0, (row?.pages_read ?? 0) - bookPages),
    bookPages,
    articleSeconds: Math.max(0, (row?.reading_seconds ?? 0) - bookSeconds),
    bookSeconds,
  };
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

export async function getAllHighlights(): Promise<(HighlightRow & { article_title: string | null; article_link: string | null; publication_id: string | null })[]> {
  const db = getDb();
  return db.getAllAsync(
    `SELECT h.*, a.title AS article_title, a.link AS article_link, a.publication_id
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

export async function toggleArticleRead(articleId: string, completed: boolean): Promise<void> {
  const db = getDb();
  const now = Date.now();
  const completedVal = completed ? 1 : 0;
  const depthVal = completed ? 1.0 : 0.0;
  
  await db.runAsync(
    `INSERT INTO reading_progress (article_id, pages_read, total_pages, scroll_depth, completed, last_read_at)
     VALUES (?, ?, 1, ?, ?, ?)
     ON CONFLICT(article_id) DO UPDATE SET
       scroll_depth = excluded.scroll_depth,
       completed = excluded.completed,
       last_read_at = excluded.last_read_at`,
    [articleId, completed ? 1 : 0, depthVal, completedVal, now],
  );
  
  import('../lib/sync').then((m) => m.syncReadingProgress(articleId)).catch(() => {});
}
