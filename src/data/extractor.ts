import { parse } from 'node-html-parser';
import { htmlToPlainText } from './rss';

export const WORDS_PER_PAGE = 275;

export interface ArticleContent {
  /** Cleaned HTML with real paragraph/image structure preserved — feed the reader's WebView with this. */
  html: string;
  plainText: string;
  pages: string[];
  wordCount: number;
}

/**
 * Resolve full article content: use feed-provided HTML if available,
 * otherwise fetch the article URL and extract main content.
 */
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** Upgrade http:// to https:// and retry on failure, same as rss.ts. */
async function fetchArticle(url: string): Promise<Response | null> {
  const httpsUrl = url.startsWith('http://') ? url.replace('http://', 'https://') : url;
  try {
    const res = await fetch(httpsUrl, { headers: FETCH_HEADERS });
    if (res.ok) return res;
    // HTTPS returned an error — try original HTTP if they differ
    if (httpsUrl !== url) {
      const fallback = await fetch(url, { headers: FETCH_HEADERS });
      return fallback.ok ? fallback : null;
    }
    return null;
  } catch {
    // HTTPS failed at network level — try original HTTP as fallback
    if (httpsUrl !== url) {
      try {
        const fallback = await fetch(url, { headers: FETCH_HEADERS });
        return fallback.ok ? fallback : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export async function resolveArticleContent(
  articleUrl: string,
  feedContentHtml?: string,
): Promise<ArticleContent | null> {
  try {
    let html: string;

    if (feedContentHtml) {
      html = feedContentHtml;
    } else {
      const res = await fetchArticle(articleUrl);
      if (!res) return null;
      const rawHtml = await res.text();
      html = extractMainHtml(rawHtml);
    }
    if (!html) return null;

    html = absolutizeUrls(promoteLazyImages(html), articleUrl);

    const plainText = htmlToPlainText(html);
    if (plainText.length < 100) return null;

    const { pages, wordCount } = buildPages(plainText);
    return { html, plainText, pages, wordCount };
  } catch {
    return null;
  }
}

/**
 * Extract the main content container's inner HTML (keeping real <p>/<img> structure)
 * instead of flattened .text — a flat string loses every paragraph break and strips
 * all images, which is why scrape-fallback articles used to render as one text wall.
 */
function extractMainHtml(html: string): string {
  const root = parse(html);

  // Remove noise nodes
  for (const tag of ['script', 'style', 'nav', 'header', 'footer', 'aside', 'noscript', 'iframe', 'form', 'svg']) {
    root.querySelectorAll(tag).forEach((n) => n.remove());
  }

  // Try semantic content containers, ordered by specificity
  const selectors = [
    'article',
    '[class*="post-content"]',
    '[class*="article-body"]',
    '[class*="entry-content"]',
    '[class*="prose"]',
    'main',
    '.content',
    '#content',
  ];

  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el) {
      const text = el.text.replace(/\s+/g, ' ').trim();
      if (text.length > 200) return el.innerHTML;
    }
  }

  // Last resort: grab all paragraphs
  const paras = root.querySelectorAll('p');
  const kept = paras.filter((p) => p.text.trim().length > 40);
  return kept.map((p) => p.outerHTML).join('\n');
}

/** Many blogs lazy-load images behind data-src/data-lazy-src with a blank placeholder
 *  in src — promote the real URL so it actually renders. */
function promoteLazyImages(html: string): string {
  return html.replace(/<img\b([^>]*)>/gi, (match, attrs) => {
    const srcMatch = attrs.match(/\bsrc="([^"]*)"/i);
    const hasRealSrc = srcMatch && srcMatch[1].trim().length > 0 && !/^data:image\/gif/i.test(srcMatch[1]);
    if (hasRealSrc) return match;
    const lazy = attrs.match(/\bdata-(?:src|lazy-src|original)="([^"]+)"/i);
    if (!lazy) return match;
    return `<img${attrs} src="${lazy[1]}">`;
  });
}

/** Scraped pages often use relative image/link URLs — resolve them against the
 *  article's own URL so they load inside the reader's baseUrl-less WebView. */
function absolutizeUrls(html: string, baseUrl: string): string {
  return html
    .replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/gi, (m, pre, src, post) => {
      if (/^(data:|https?:)/i.test(src)) return m;
      try { return pre + new URL(src, baseUrl).href + post; } catch { return m; }
    })
    .replace(/(<a\b[^>]*\bhref=")([^"]+)(")/gi, (m, pre, href, post) => {
      if (/^(https?:|mailto:|#)/i.test(href)) return m;
      try { return pre + new URL(href, baseUrl).href + post; } catch { return m; }
    })
    .replace(/\ssrcset="[^"]*"/gi, '');
}

function buildPages(plainText: string): { pages: string[]; wordCount: number } {
  const words = plainText.split(/\s+/).filter(Boolean);
  const pages: string[] = [];
  for (let i = 0; i < words.length; i += WORDS_PER_PAGE) {
    pages.push(words.slice(i, i + WORDS_PER_PAGE).join(' '));
  }
  return { pages, wordCount: words.length };
}

export function wordCountToPages(wordCount: number): number {
  return Math.max(1, Math.ceil(wordCount / WORDS_PER_PAGE));
}
