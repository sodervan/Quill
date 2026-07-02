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
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Perch/1.0 RSS Reader' },
  });
  if (!res.ok) throw new Error(`Feed fetch failed: ${res.status}`);
  const xml = await res.text();
  return parseXml(xml);
}

function parseXml(xml: string): FeedItem[] {
  const root = parse(xml, XML_PARSE_OPTS);
  // RSS 2.0 — use 'item' not 'channel > item' (direct-child selector is unreliable on XML)
  const rssItems = root.querySelectorAll('item');
  if (rssItems.length > 0) return rssItems.map(parseRssItem);
  // Atom
  const atomEntries = root.querySelectorAll('entry');
  if (atomEntries.length > 0) return atomEntries.map(parseAtomEntry);
  return [];
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
