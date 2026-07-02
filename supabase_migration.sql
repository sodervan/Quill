-- Run this entire script once in your Supabase SQL editor
-- (Dashboard → SQL Editor → New query → paste → Run)

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
