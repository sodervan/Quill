import { supabase } from './supabase';
import type { RemoteSourceRow, ArticleRow, HighlightRow } from '../data/db';

async function uid(): Promise<string | null> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.user?.id ?? null;
  } catch { return null; }
}

// ── Writes ────────────────────────────────────────────────────────────────────

export async function syncFollow(sourceId: string): Promise<void> {
  const userId = await uid();
  if (!userId) return;
  try {
    await supabase.from('user_sources').upsert({ user_id: userId, source_id: sourceId });
  } catch {}
}

export async function syncUnfollow(sourceId: string): Promise<void> {
  const userId = await uid();
  if (!userId) return;
  try {
    await Promise.all([
      supabase.from('user_sources').delete().eq('user_id', userId).eq('source_id', sourceId),
      supabase.from('user_remote_sources').delete().eq('user_id', userId).eq('source_id', sourceId),
    ]);
  } catch {}
}

export async function syncRemoteSource(src: RemoteSourceRow): Promise<void> {
  const userId = await uid();
  if (!userId) return;
  try {
    await supabase.from('user_remote_sources').upsert({
      user_id: userId,
      source_id: src.id,
      name: src.name,
      feed_url: src.feed_url,
      description: src.description,
      color: src.color,
      added_at: src.added_at,
    });
  } catch {}
}

export async function syncSave(articleId: string): Promise<void> {
  const userId = await uid();
  if (!userId) return;
  try {
    await supabase.from('user_saved').upsert({ user_id: userId, article_id: articleId });
  } catch {}
}

// Sync full article payload so Library survives reinstall
export async function syncSaveArticle(article: ArticleRow): Promise<void> {
  const userId = await uid();
  if (!userId) return;
  try {
    await supabase.from('user_saved_articles').upsert({
      user_id: userId,
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
  const userId = await uid();
  if (!userId) return;
  try {
    await Promise.all([
      supabase.from('user_saved').delete().eq('user_id', userId).eq('article_id', articleId),
      supabase.from('user_saved_articles').delete().eq('user_id', userId).eq('article_id', articleId),
    ]);
  } catch {}
}

export async function syncHighlight(h: HighlightRow): Promise<void> {
  const userId = await uid();
  if (!userId) return;
  try {
    await supabase.from('user_highlights').upsert({
      user_id: userId,
      article_id: h.article_id,
      selected_text: h.selected_text,
      color: h.color,
      created_at: h.created_at,
    });
  } catch {}
}

export async function syncDeleteHighlight(articleId: string, createdAt: number): Promise<void> {
  const userId = await uid();
  if (!userId) return;
  try {
    await supabase.from('user_highlights')
      .delete()
      .eq('user_id', userId)
      .eq('article_id', articleId)
      .eq('created_at', createdAt);
  } catch {}
}

export async function syncReadEvent(
  articleId: string,
  secondsRead: number,
  scrollDepth: number,
  qualifying: boolean,
): Promise<void> {
  const userId = await uid();
  if (!userId) return;
  try {
    await supabase.from('read_events').insert({
      user_id: userId,
      article_id: articleId,
      seconds_read: secondsRead,
      scroll_depth: scrollDepth,
      qualifying,
    });
    if (qualifying) {
      const today = new Date().toISOString().slice(0, 10);
      try {
        await supabase.rpc('increment_streak', { p_user_id: userId, p_date: today });
      } catch {
        await supabase.from('daily_streak').upsert(
          { user_id: userId, date: today, qualifying_reads: 1 },
          { onConflict: 'user_id,date' },
        );
      }
    }
  } catch {}
}

// ── Upload local → Supabase ───────────────────────────────────────────────────

/**
 * Pushes all existing local SQLite data up to Supabase.
 * Called on first sign-in so pre-login activity isn't lost.
 * Uses upsert throughout so it's safe to call multiple times.
 */
export async function uploadLocalToSupabase(): Promise<void> {
  const userId = await uid();
  if (!userId) return;

  const db = await import('../data/db');

  // 1. Followed publications
  try {
    const ids = await db.getFollowedIds();
    if (ids.length > 0) {
      await supabase
        .from('user_sources')
        .upsert(ids.map((source_id) => ({ user_id: userId, source_id })));
    }
  } catch {}

  // 2. Remote source metadata
  try {
    const remoteSrcs = await db.getAllRemoteSources();
    if (remoteSrcs.length > 0) {
      await supabase.from('user_remote_sources').upsert(
        remoteSrcs.map((r) => ({
          user_id: userId,
          source_id: r.id,
          name: r.name,
          feed_url: r.feed_url,
          description: r.description,
          color: r.color,
          added_at: r.added_at,
        })),
      );
    }
  } catch {}

  // 3. Saved articles — push full metadata so Library survives reinstall
  try {
    const savedArticles = await db.getSavedArticles();
    if (savedArticles.length > 0) {
      await supabase
        .from('user_saved')
        .upsert(savedArticles.map((a) => ({ user_id: userId, article_id: a.id })));

      await supabase.from('user_saved_articles').upsert(
        savedArticles.map((a) => ({
          user_id: userId,
          article_id: a.id,
          title: a.title,
          link: a.link,
          publication_id: a.publication_id,
          pub_date: a.pub_date,
          excerpt: a.excerpt ?? null,
          image_url: a.image_url ?? null,
          saved_at: Date.now(),
        })),
      );
    }
  } catch {}

  // 4. Highlights
  try {
    const highlights = await db.getAllHighlights();
    if (highlights.length > 0) {
      await supabase.from('user_highlights').upsert(
        highlights.map((h) => ({
          user_id: userId,
          article_id: h.article_id,
          selected_text: h.selected_text,
          color: h.color,
          created_at: h.created_at,
        })),
      );
    }
  } catch {}
}

// ── Restore ───────────────────────────────────────────────────────────────────

/**
 * Called once on sign-in. Pulls everything from Supabase and rebuilds
 * the local SQLite database so the app works identically after reinstall.
 */
export async function restoreFromSupabase(): Promise<void> {
  const userId = await uid();
  if (!userId) return;

  const db = await import('../data/db');

  // 1. Restore followed curated publications
  try {
    const { data: sources } = await supabase
      .from('user_sources')
      .select('source_id')
      .eq('user_id', userId);

    if (sources?.length) {
      for (const { source_id } of sources) {
        // Use db directly to avoid re-triggering sync on restore
        const rawDb = db.getDb();
        await rawDb.runAsync(
          `INSERT OR IGNORE INTO followed_publications (id, followed_at) VALUES (?, ?)`,
          [source_id, Date.now()],
        );
      }
    }
  } catch {}

  // 2. Restore remote sources (Feedly-followed publications)
  try {
    const { data: remoteSrcs } = await supabase
      .from('user_remote_sources')
      .select('*')
      .eq('user_id', userId);

    if (remoteSrcs?.length) {
      for (const r of remoteSrcs) {
        const src: RemoteSourceRow = {
          id: r.source_id,
          name: r.name,
          feed_url: r.feed_url,
          description: r.description ?? '',
          color: r.color ?? '#60A5FA',
          added_at: r.added_at ?? Date.now(),
        };
        await db.upsertRemoteSource(src);
        const rawDb = db.getDb();
        await rawDb.runAsync(
          `INSERT OR IGNORE INTO followed_publications (id, followed_at) VALUES (?, ?)`,
          [src.id, src.added_at],
        );
      }
    }
  } catch {}

  // 3. Restore saved articles (full metadata so Library shows content)
  try {
    const { data: saved } = await supabase
      .from('user_saved_articles')
      .select('*')
      .eq('user_id', userId);

    if (saved?.length) {
      const articles: ArticleRow[] = saved.map((s: any) => ({
        id: s.article_id,
        publication_id: s.publication_id,
        title: s.title,
        link: s.link,
        pub_date: s.pub_date ?? 0,
        excerpt: s.excerpt ?? null,
        content_html: null,
        image_url: s.image_url ?? null,
        word_count: null,
        fetched_at: Date.now(),
      }));

      await db.upsertArticles(articles);

      const rawDb = db.getDb();
      for (const s of saved) {
        await rawDb.runAsync(
          `INSERT OR IGNORE INTO saved_articles (article_id, saved_at) VALUES (?, ?)`,
          [s.article_id, s.saved_at ?? Date.now()],
        );
      }
    }
  } catch {}

  // 4. Restore highlights
  try {
    const { data: highlights } = await supabase
      .from('user_highlights')
      .select('*')
      .eq('user_id', userId);

    if (highlights?.length) {
      const rawDb = db.getDb();
      for (const h of highlights) {
        await rawDb.runAsync(
          `INSERT OR IGNORE INTO highlights (article_id, selected_text, color, created_at) VALUES (?, ?, ?, ?)`,
          [h.article_id, h.selected_text, h.color, h.created_at],
        );
      }
    }
  } catch {}
}
