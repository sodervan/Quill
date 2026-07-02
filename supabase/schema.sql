-- Run this in your Supabase SQL editor at supabase.com → SQL Editor

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Sources (publications / RSS feeds) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS sources (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  author      TEXT,
  description TEXT,
  feed_url    TEXT NOT NULL,
  website_url TEXT,
  color       TEXT DEFAULT '#C8AA6E',
  emoji       TEXT DEFAULT '📄',
  topics      TEXT[] DEFAULT '{}',
  verified    BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Cached articles (populated by Edge Function cron) ───────────────────────
CREATE TABLE IF NOT EXISTS articles (
  id           TEXT PRIMARY KEY,    -- "{source_id}::{link}"
  source_id    TEXT REFERENCES sources(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  link         TEXT NOT NULL,
  pub_date     TIMESTAMPTZ,
  excerpt      TEXT,
  content_html TEXT,
  word_count   INTEGER,
  fetched_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS articles_source_id_pub_date ON articles(source_id, pub_date DESC);

-- ── User: followed sources ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_sources (
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  source_id   TEXT REFERENCES sources(id) ON DELETE CASCADE,
  followed_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, source_id)
);

-- ── User: saved articles ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_saved (
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  article_id TEXT REFERENCES articles(id) ON DELETE CASCADE,
  saved_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, article_id)
);

-- ── User: reading events ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS read_events (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  article_id   TEXT REFERENCES articles(id) ON DELETE CASCADE,
  seconds_read INTEGER DEFAULT 0,
  scroll_depth REAL DEFAULT 0,
  qualifying   BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── User: daily streak log ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_streak (
  user_id          UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  date             DATE NOT NULL,
  qualifying_reads INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

-- ── Row-level security ───────────────────────────────────────────────────────
ALTER TABLE sources     ENABLE ROW LEVEL SECURITY;
ALTER TABLE articles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_saved  ENABLE ROW LEVEL SECURITY;
ALTER TABLE read_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_streak ENABLE ROW LEVEL SECURITY;

-- Sources and articles are public-read
CREATE POLICY "sources_public_read"  ON sources  FOR SELECT USING (TRUE);
CREATE POLICY "articles_public_read" ON articles FOR SELECT USING (TRUE);

-- Users can only touch their own rows
CREATE POLICY "user_sources_self"  ON user_sources  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "user_saved_self"    ON user_saved    USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "read_events_self"   ON read_events   USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "daily_streak_self"  ON daily_streak  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ── Seed sources from the app's publication list ─────────────────────────────
-- (run after running the app once to export PUBLICATIONS, or paste manually)
