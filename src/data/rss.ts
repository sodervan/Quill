import { parse } from 'node-html-parser';

// Disable void-tag treatment so RSS <link>url</link> text content is readable.
// In HTML mode, <link> is a void element and its text content is ignored.
const XML_PARSE_OPTS = { voidTag: { tags: [] as string[] } };

export interface FeedItem {
  title: string;
  link: string;
  pubDate: Date;
  excerpt: string;
  contentHtml?: string;
  imageUrl?: string;
}

export async function fetchFeed(url: string): Promise<FeedItem[]> {
  const { items } = await fetchFeedPage(url);
  return items;
}

const FEED_HEADERS = {
  'User-Agent': 'Perch/1.0 RSS Reader',
  'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
};

async function fetchWithTimeout(url: string, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: FEED_HEADERS });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

/** Fetches one page and returns items + the URL of the next page (if any). */
export async function fetchFeedPage(url: string): Promise<{ items: FeedItem[]; nextUrl: string | null }> {
  // Prefer HTTPS; fall back to the original URL if the upgrade 4xx/5xx-fails
  const httpsUrl = url.startsWith('http://') ? url.replace('http://', 'https://') : url;

  let res: Response;
  try {
    res = await fetchWithTimeout(httpsUrl);
    if (!res.ok && httpsUrl !== url) {
      // HTTPS upgrade returned an error — try original URL
      res = await fetchWithTimeout(url);
    }
  } catch {
    if (httpsUrl !== url) {
      // HTTPS timed out or network-failed — try original HTTP URL
      res = await fetchWithTimeout(url);
    } else {
      throw new Error('Feed fetch failed: network error');
    }
  }

  if (!res.ok) throw new Error(`Feed fetch failed: ${res.status}`);
  const xml = await res.text();
  return parseXmlWithPagination(xml, res.url || url);
}

function extractNextUrl(xml: string, root: ReturnType<typeof parse>, baseUrl: string): string | null {
  // 1. CSS query for <link rel="next"> (Atom) and <atom:link rel="next"> (RSS+Atom ns)
  for (const el of root.querySelectorAll('link')) {
    if (el.getAttribute('rel') === 'next') {
      const href = el.getAttribute('href') ?? el.text?.trim();
      if (href) return resolveUrl(href, baseUrl);
    }
  }
  // 2. Regex fallback for namespace-prefixed <atom:link rel="next"> that CSS may miss
  const m = xml.match(/<[a-z]+:link[^>]+rel=["']next["'][^>]*>/i)
    ?? xml.match(/<[a-z]+:link[^>]+>[^<]*<\/[a-z]+:link>/i);
  if (m) {
    const hm = m[0].match(/href=["']([^"']+)["']/);
    if (hm?.[1]) return resolveUrl(hm[1], baseUrl);
  }
  return null;
}

function resolveUrl(href: string, base: string): string {
  if (href.startsWith('http')) return href;
  try { return new URL(href, base).href; } catch { return href; }
}

function parseXmlWithPagination(xml: string, baseUrl: string): { items: FeedItem[]; nextUrl: string | null } {
  const root = parse(xml, XML_PARSE_OPTS);
  const nextUrl = extractNextUrl(xml, root, baseUrl);
  const rssItems = root.querySelectorAll('item');
  if (rssItems.length > 0) return { items: rssItems.map(parseRssItem), nextUrl };
  const atomEntries = root.querySelectorAll('entry');
  if (atomEntries.length > 0) return { items: atomEntries.map(parseAtomEntry), nextUrl };
  return { items: [], nextUrl };
}

function parseRssItem(el: ReturnType<typeof parse>): FeedItem {
  const rawTitle = el.querySelector('title')?.rawText ?? el.querySelector('title')?.text ?? '';
  const title = stripCdata(rawTitle).trim() || '(no title)';

  // link text content is now readable because we disabled void-tag treatment
  const linkText = el.querySelector('link')?.text?.trim();
  const linkHref = el.querySelector('link')?.getAttribute('href');
  const guid = el.querySelector('guid')?.text?.trim();
  const link = (linkText || linkHref || guid || '').trim();

  const pubDateRaw = el.querySelector('pubDate')?.rawText ?? el.querySelector('pubDate')?.text ?? '';
  const pubDateStr = stripCdata(pubDateRaw).trim();
  const parsedPubDate = pubDateStr ? new Date(pubDateStr) : null;
  const pubDate = parsedPubDate && !isNaN(parsedPubDate.getTime()) ? parsedPubDate : new Date(0);

  const contentNode = el.querySelector('content\\:encoded') ?? el.querySelector('encoded');
  const contentRaw = contentNode ? stripCdata(contentNode.rawText || contentNode.innerHTML) : undefined;

  const descNode = el.querySelector('description');
  const descriptionRaw = descNode ? stripCdata(descNode.rawText || descNode.innerHTML) : '';
  const excerpt = descriptionRaw ? htmlToPlainText(descriptionRaw).slice(0, 300) : '';

  return { title, link, pubDate, excerpt, contentHtml: contentRaw, imageUrl: extractImage(el, contentRaw) };
}

function parseAtomEntry(el: ReturnType<typeof parse>): FeedItem {
  const rawAtomTitle = el.querySelector('title')?.rawText ?? el.querySelector('title')?.text ?? '';
  const title = stripCdata(rawAtomTitle).trim() || '(no title)';
  const link =
    el.querySelector('link[rel="alternate"]')?.getAttribute('href') ??
    el.querySelector('link')?.getAttribute('href') ??
    el.querySelector('link')?.text?.trim() ??
    '';
  const pubDateRawAtom =
    el.querySelector('published')?.rawText ?? el.querySelector('published')?.text ??
    el.querySelector('updated')?.rawText ?? el.querySelector('updated')?.text ?? '';
  const pubDateStrAtom = stripCdata(pubDateRawAtom).trim();
  const parsedAtomDate = pubDateStrAtom ? new Date(pubDateStrAtom) : null;
  const pubDate = parsedAtomDate && !isNaN(parsedAtomDate.getTime()) ? parsedAtomDate : new Date(0);

  const contentNode = el.querySelector('content');
  const contentRaw = contentNode ? stripCdata(contentNode.rawText || contentNode.innerHTML) : undefined;
  const summaryNode = el.querySelector('summary');
  const summaryRaw = summaryNode ? stripCdata(summaryNode.rawText || summaryNode.innerHTML) : '';
  const excerpt = summaryRaw ? htmlToPlainText(summaryRaw).slice(0, 300) : '';

  return { title, link, pubDate, excerpt, contentHtml: contentRaw, imageUrl: extractImage(el, contentRaw) };
}

function extractImage(el: ReturnType<typeof parse>, contentHtml?: string): string | undefined {
  // 1. <media:content url="..." medium="image">
  const mediaContent = el.querySelector('media\\:content') ?? el.querySelector('content[medium="image"]');
  const mcUrl = mediaContent?.getAttribute('url');
  if (mcUrl && isImageUrl(mcUrl)) return mcUrl;

  // 2. <media:thumbnail url="...">
  const mediaThumbnail = el.querySelector('media\\:thumbnail') ?? el.querySelector('thumbnail');
  const mtUrl = mediaThumbnail?.getAttribute('url');
  if (mtUrl && isImageUrl(mtUrl)) return mtUrl;

  // 3. <enclosure type="image/...">
  const enclosure = el.querySelector('enclosure');
  if (enclosure && (enclosure.getAttribute('type') ?? '').startsWith('image/')) {
    const encUrl = enclosure.getAttribute('url');
    if (encUrl) return encUrl;
  }

  // 4. First <img> in content HTML
  if (contentHtml) {
    const match = contentHtml.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (match?.[1] && isImageUrl(match[1])) return match[1];
  }

  return undefined;
}

function isImageUrl(url: string): boolean {
  return /^https?:\/\/.+\.(jpe?g|png|webp|gif|avif)/i.test(url) || url.includes('image') || url.includes('img');
}

export function stripCdata(raw: string): string {
  // Replace ALL CDATA sections anywhere in the string (feeds vary wildly)
  return raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

export function htmlToPlainText(html: string): string {
  const cleaned = stripCdata(html);
  try {
    const root = parse(cleaned, XML_PARSE_OPTS);
    return root.text.replace(/\s+/g, ' ').trim();
  } catch {
    return cleaned.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}
