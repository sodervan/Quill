-- Run this entire script in your Supabase SQL editor
-- (Dashboard → SQL Editor → New query → paste → Run)
-- Safe to re-run: uses IF NOT EXISTS / IF NOT EXISTS / ADD COLUMN IF NOT EXISTS

-- ── Curated publication follows ───────────────────────────────────────────────
create table if not exists user_sources (
  user_id   uuid references auth.users(id) on delete cascade,
  source_id text not null,
  primary key (user_id, source_id)
);
alter table user_sources enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies where tablename = 'user_sources' and policyname = 'Users own their sources'
  ) then
    create policy "Users own their sources" on user_sources for all using (auth.uid() = user_id);
  end if;
end $$;

-- ── Saved article IDs ─────────────────────────────────────────────────────────
create table if not exists user_saved (
  user_id    uuid references auth.users(id) on delete cascade,
  article_id text not null,
  primary key (user_id, article_id)
);
alter table user_saved enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies where tablename = 'user_saved' and policyname = 'Users own their saved'
  ) then
    create policy "Users own their saved" on user_saved for all using (auth.uid() = user_id);
  end if;
end $$;

-- ── User settings (daily goal, preferences) ───────────────────────────────────
create table if not exists user_settings (
  user_id uuid references auth.users(id) on delete cascade,
  key     text not null,
  value   text not null,
  primary key (user_id, key)
);
alter table user_settings enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies where tablename = 'user_settings' and policyname = 'Users own their settings'
  ) then
    create policy "Users own their settings" on user_settings for all using (auth.uid() = user_id);
  end if;
end $$;

-- ── Remote source metadata (Feedly / web-followed publications) ─────────────
create table if not exists user_remote_sources (
  user_id     uuid    references auth.users(id) on delete cascade,
  source_id   text    not null,
  name        text    not null,
  feed_url    text    not null,
  description text    not null default '',
  color       text    not null default '#60A5FA',
  added_at    bigint  not null default (extract(epoch from now()) * 1000)::bigint,
  primary key (user_id, source_id)
);
alter table user_remote_sources enable row level security;
create policy "Users own their remote sources"
  on user_remote_sources for all using (auth.uid() = user_id);

-- ── Saved articles with full metadata (so Library survives reinstall) ───────
create table if not exists user_saved_articles (
  user_id        uuid   references auth.users(id) on delete cascade,
  article_id     text   not null,
  title          text   not null,
  link           text   not null,
  publication_id text   not null,
  pub_date       bigint not null default 0,
  excerpt        text,
  image_url      text,
  saved_at       bigint not null default (extract(epoch from now()) * 1000)::bigint,
  primary key (user_id, article_id)
);
alter table user_saved_articles enable row level security;
create policy "Users own their saved articles"
  on user_saved_articles for all using (auth.uid() = user_id);

-- ── Highlights (text selections saved while reading) ─────────────────────────
create table if not exists user_highlights (
  user_id       uuid   references auth.users(id) on delete cascade,
  article_id    text   not null,
  selected_text text   not null,
  color         text   not null default '#C8AA6E',
  created_at    bigint not null,
  primary key (user_id, article_id, created_at)
);
alter table user_highlights enable row level security;
create policy "Users own their highlights"
  on user_highlights for all using (auth.uid() = user_id);

-- ── Daily reading log (source of truth for streaks) ──────────────────────────
create table if not exists user_daily_log (
  user_id          uuid    references auth.users(id) on delete cascade,
  date             text    not null,
  qualifying_reads integer not null default 0,
  pages_read       integer not null default 0,
  primary key (user_id, date)
);
alter table user_daily_log enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies where tablename = 'user_daily_log' and policyname = 'Users own their daily log'
  ) then
    create policy "Users own their daily log" on user_daily_log for all using (auth.uid() = user_id);
  end if;
end $$;
-- Add pages_read if table already existed without it
alter table user_daily_log add column if not exists pages_read integer not null default 0;

-- ── Reading progress (scroll depth + page progress, synced on leave) ─────────
create table if not exists user_reading_progress (
  user_id     uuid    references auth.users(id) on delete cascade,
  article_id  text    not null,
  pages_read  integer not null default 0,
  total_pages integer not null default 1,
  scroll_depth real   not null default 0,
  completed   boolean not null default false,
  last_read_at bigint not null,
  primary key (user_id, article_id)
);
alter table user_reading_progress enable row level security;
create policy "Users own their reading progress"
  on user_reading_progress for all using (auth.uid() = user_id);
