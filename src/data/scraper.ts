import { parse } from 'node-html-parser';
import type { FeedItem } from './rss';

const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const NOISE = 'script, style, nav, header, footer, aside, noscript, iframe, [class*="sidebar"], [class*="menu"], [id*="sidebar"], [id*="menu"]';
const MIN_TITLE = 8;

// Strict pagination text — excludes per-article "Read More" links
const NEXT_TEXT = /^\s*(next(\s+page)?|older(\s+posts?)?|→|»|›)\s*$/i;

/**
 * Derive the blog/archive page URL from a feed URL by stripping known feed suffixes.
 * e.g. https://ycombinator.com/blog/rss/ → https://ycombinator.com/blog/
 *      https://nav.al/feed               → https://nav.al/
 */
export function deriveBlogUrl(feedUrl: string): string | null {
  try {
    const u = new URL(feedUrl);
    // Redirect/aggregator services — can't derive the real blog URL
    if (/feedburner\.com|feedblitz\.com|feeds2?\./i.test(u.hostname)) return null;
    // If the URL points directly to an HTML page that looks like an article listing,
    // treat it as the blog URL itself (e.g. paulgraham.com/articles.html)
    if (/\/(articles?|posts?|essays?|archive|blog|writing|index)\.html?$/i.test(u.pathname)) {
      return feedUrl;
    }
    // Strip common feed file/path endings, including filename variants like rss.html, feed.php
    const path = u.pathname
      .replace(/\/(feed|rss|atom|index)(\.xml|\.rss|\.json|\.html|\.php|\.asp)?\/?$/i, '')
      || '/';
    const blogUrl = new URL(path, u.origin).href;
    // Nothing useful was stripped — same URL or effectively the same filename
    if (blogUrl === feedUrl || blogUrl === u.origin + '/' + feedUrl.split('/').pop()) return null;
    return blogUrl;
  } catch { return null; }
}

function resolve(href: string, base: string): string {
  if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return '';
  try { return new URL(href, base).href; } catch { return ''; }
}

function sameDomain(url: string, host: string): boolean {
  try { return new URL(url).hostname === host; } catch { return false; }
}

function parseDate(el: any): Date {
  const str = el?.getAttribute?.('datetime') ?? el?.text?.trim() ?? '';
  const d = str ? new Date(str) : new Date(0);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

function buildItem(
  title: string,
  link: string,
  container: any,
  baseUrl: string,
): FeedItem | null {
  if (!link || title.length < MIN_TITLE) return null;
  const pText = container?.querySelector?.('p')?.text?.trim() ?? '';
  const timeEl = container?.querySelector?.('time');
  const imgSrc = container?.querySelector?.('img')?.getAttribute?.('src') ?? '';
  return {
    title,
    link,
    pubDate: parseDate(timeEl),
    excerpt: pText.slice(0, 300),
    contentHtml: undefined,
    imageUrl: imgSrc ? resolve(imgSrc, baseUrl) || undefined : undefined,
  };
}

function findNextUrl(root: any, baseUrl: string, baseHost: string): string | null {
  // 1. <link rel="next"> in <head> — most reliable (Ghost, WordPress)
  const headLink = root.querySelector('head link[rel="next"]')
    ?? root.querySelector('link[rel="next"]');
  if (headLink) {
    const u = resolve(headLink.getAttribute('href') ?? '', baseUrl);
    if (u) return u;
  }

  // 2. <a rel="next">
  const relNext = root.querySelector('a[rel="next"]');
  if (relNext) {
    const u = resolve(relNext.getAttribute('href') ?? '', baseUrl);
    if (u && sameDomain(u, baseHost)) return u;
  }

  // 3. <a href="...?page=N"> or <a href=".../page/N/">  URL-pattern match
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    if (/(\?|&)page=\d+|\/page\/\d+/.test(href)) {
      const u = resolve(href, baseUrl);
      if (u && sameDomain(u, baseHost) && u !== baseUrl) return u;
    }
  }

  // 4. Strict pagination text (Next, Older posts, →)
  for (const a of root.querySelectorAll('a')) {
    if (NEXT_TEXT.test(a.text)) {
      const u = resolve(a.getAttribute('href') ?? '', baseUrl);
      if (u && sameDomain(u, baseHost) && u !== baseUrl) return u;
    }
  }

  return null;
}

function extractArticles(root: any, baseUrl: string, baseHost: string): FeedItem[] {
  const seen = new Set<string>();
  const items: FeedItem[] = [];

  function add(title: string, link: string, container: any) {
    if (seen.has(link)) return;
    const item = buildItem(title, link, container, baseUrl);
    if (!item) return;
    seen.add(link);
    items.push(item);
  }

  // Strategy 1: <article> elements — most semantically reliable
  for (const article of root.querySelectorAll('article')) {
    const headingA = article.querySelector('h1 a, h2 a, h3 a, h4 a');
    const heading = article.querySelector('h1, h2, h3, h4');
    const anyA = article.querySelector('a[href]');
    const linkEl = headingA ?? anyA;
    if (!linkEl) continue;
    const link = resolve(linkEl.getAttribute('href') ?? '', baseUrl);
    if (!link || !sameDomain(link, baseHost)) continue;
    const title = heading?.text?.trim() ?? linkEl.text?.trim() ?? '';
    add(title, link, article);
  }

  // Strategy 2: headings containing links — simple/custom blogs
  if (items.length < 3) {
    for (const a of root.querySelectorAll('h2 a, h3 a')) {
      const link = resolve(a.getAttribute('href') ?? '', baseUrl);
      if (!link || !sameDomain(link, baseHost)) continue;
      const title = a.text?.trim() ?? '';
      // Walk up two levels for date/excerpt context
      const container = a.parentNode?.parentNode ?? a.parentNode;
      add(title, link, container);
    }
  }

  return items;
}

/**
 * Scrape a web page for article links and a pagination "next" URL.
 * Returns the same shape as fetchFeedPage so callers are unified.
 *
 * Strategy A: data-page JSON (Ghost/React blogs like YC)
 * Strategy B: WordPress REST API for /page/N paginated URLs
 * Strategy C: HTML scraping (generic fallback)
 */
export async function scrapeForArticles(url: string): Promise<{ items: FeedItem[]; nextUrl: string | null }> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Scrape failed: ${res.status}`);
  const html = await res.text();

  const parsedUrl = new URL(url);
  const { origin } = parsedUrl;
  const baseHost = parsedUrl.hostname;

  // ── Strategy A: Embedded data-page JSON (e.g. YC Ghost blog) ──────────────
  // Ghost/custom React sites embed post data as JSON in a data-page attribute,
  // so normal HTML selectors find nothing. Parse the JSON directly.
  // Use indexOf+substring instead of regex to avoid large-string regex issues in Hermes.
  const dpStart = html.indexOf('data-page="');
  const dpEnd = dpStart !== -1 ? html.indexOf('"', dpStart + 11) : -1;
  const dpRaw = dpStart !== -1 && dpEnd > dpStart ? html.substring(dpStart + 11, dpEnd) : null;
  if (dpRaw) {
    try {
      const decoded = dpRaw
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
      const json = JSON.parse(decoded) as { props?: { posts?: any[]; pagination?: { page: number; pages: number } } };
      const posts = json.props?.posts;
      if (Array.isArray(posts) && posts.length > 0) {
        const pathBase = parsedUrl.pathname.replace(/\/+$/, '');
        // Avoid URL.searchParams — not reliable in all RN URL polyfills
        const pageParam = url.match(/[?&]page=(\d+)/);
        const currentPage = pageParam ? parseInt(pageParam[1], 10) : 1;
        const items: FeedItem[] = posts
          .filter((p: any) => p.slug && p.title)
          .map((p: any) => ({
            title: p.title as string,
            link: `${origin}${pathBase}/${p.slug as string}`,
            pubDate: p.published_at ? new Date(p.published_at as string) : new Date(0),
            excerpt: ((p.excerpt as string | undefined) ?? '').slice(0, 300),
            contentHtml: undefined,
            imageUrl: (p.feature_image as string | undefined) ?? undefined,
          }));
        if (items.length > 0) {
          const pag = json.props?.pagination;
          let nextUrl: string | null = null;
          if (pag && pag.page < pag.pages) {
            nextUrl = `${origin}${pathBase}?page=${pag.page + 1}`;
          } else if (!pag && items.length >= 8) {
            // No pagination object — assume more pages if we got a full page
            nextUrl = `${origin}${pathBase}?page=${currentPage + 1}`;
          }
          return { items, nextUrl };
        }
      }
    } catch (e) {
      console.warn('[scraper] data-page parse failed for', url, e instanceof Error ? e.message : e);
    }
  }

  // ── Strategy B: WordPress REST API for /page/N URLs ────────────────────────
  // WordPress sites with AJAX pagination render the same HTML on every /page/N.
  // Use the WP REST API to get the actual paginated content.
  const wpPageMatch = url.match(/\/page\/(\d+)\/?(?:\?.*)?$/);
  if (wpPageMatch) {
    const pageNum = parseInt(wpPageMatch[1], 10);
    try {
      const wpUrl = `${origin}/wp-json/wp/v2/posts?per_page=15&page=${pageNum}&_fields=title,link,date,excerpt`;
      const wpRes = await fetch(wpUrl, { headers: { 'User-Agent': UA } });
      if (wpRes.ok) {
        const posts = (await wpRes.json()) as any[];
        if (Array.isArray(posts) && posts.length > 0 && posts[0]?.link) {
          const totalPages = parseInt(wpRes.headers.get('X-WP-TotalPages') ?? '1', 10);
          const items: FeedItem[] = posts.map((p) => ({
            title: ((p.title?.rendered as string) ?? '').replace(/<[^>]*>/g, '').trim() || '(no title)',
            link: p.link as string,
            pubDate: p.date ? new Date(p.date as string) : new Date(0),
            excerpt: ((p.excerpt?.rendered as string) ?? '')
              .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300),
            contentHtml: undefined,
            imageUrl: undefined,
          }));
          const nextUrl = pageNum < totalPages
            ? url.replace(/\/page\/\d+/, `/page/${pageNum + 1}`)
            : null;
          return { items, nextUrl };
        }
      }
    } catch {}
  }

  // ── Strategy C: HTML scraping (generic fallback) ───────────────────────────
  const root = parse(html);

  // Extract next URL BEFORE removing noise so <head><link rel="next"> is still present
  const nextUrl = findNextUrl(root, url, baseHost);

  // Strip clutter for article extraction
  for (const el of root.querySelectorAll(NOISE)) el.remove();

  const items = extractArticles(root, url, baseHost);

  return { items, nextUrl };
}
