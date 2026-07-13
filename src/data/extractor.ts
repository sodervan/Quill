import { parse } from 'node-html-parser';
import { htmlToPlainText } from './rss';

export const WORDS_PER_PAGE = 275;

export interface ArticleContent {
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
    let plainText: string;

    if (feedContentHtml) {
      plainText = htmlToPlainText(feedContentHtml);
    } else {
      const res = await fetchArticle(articleUrl);
      if (!res) return null;
      const html = await res.text();
      plainText = extractMainText(html);
    }

    if (plainText.length < 100) return null;
    return buildPages(plainText);
  } catch {
    return null;
  }
}

function extractMainText(html: string): string {
  const root = parse(html);

  // Remove noise nodes
  for (const tag of ['script', 'style', 'nav', 'header', 'footer', 'aside', 'noscript', 'iframe']) {
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
      if (text.length > 200) return text;
    }
  }

  // Last resort: grab all paragraphs
  const paras = root.querySelectorAll('p');
  const text = paras.map((p) => p.text.trim()).filter((t) => t.length > 40).join('\n\n');
  return text.replace(/\s+/g, ' ').trim();
}

function buildPages(plainText: string): ArticleContent {
  const words = plainText.split(/\s+/).filter(Boolean);
  const pages: string[] = [];
  for (let i = 0; i < words.length; i += WORDS_PER_PAGE) {
    pages.push(words.slice(i, i + WORDS_PER_PAGE).join(' '));
  }
  return { plainText, pages, wordCount: words.length };
}

export function wordCountToPages(wordCount: number): number {
  return Math.max(1, Math.ceil(wordCount / WORDS_PER_PAGE));
}
