export interface RemoteSource {
  feedUrl: string;
  name: string;
  description: string;
  subscribers: number;
  websiteUrl?: string;
}

const TOPIC_QUERIES: Record<string, string> = {
  foryou:     'best blogs reading newsletters',
  essays:     'essays writing ideas culture',
  tech:       'technology software programming',
  startups:   'startups entrepreneurship founders',
  science:    'science research discovery nature',
  news:       'news journalism world affairs',
  philosophy: 'philosophy ethics ideas',
  ai:         'artificial intelligence machine learning',
  design:     'design ux product creativity',
};

export async function searchFeedly(query: string, count = 12): Promise<RemoteSource[]> {
  try {
    const url = `https://feedly.com/v3/search/feeds?query=${encodeURIComponent(query)}&count=${count}&locale=en`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.results ?? [])
      .map((r: any): RemoteSource | null => {
        const feedUrlRaw = String(r.feedId ?? '').replace(/^feed\//, '');
        if (!feedUrlRaw.startsWith('http')) return null;
        // Upgrade http:// → https:// — Feedly stores old feed IDs with http://
        const feedUrl = feedUrlRaw.startsWith('http://') ? feedUrlRaw.replace('http://', 'https://') : feedUrlRaw;
        const websiteRaw = String(r.website ?? '').trim();
        return {
          feedUrl,
          name: String(r.title ?? websiteRaw ?? feedUrl).slice(0, 60),
          description: String(r.description ?? '').slice(0, 200),
          subscribers: Number(r.subscribers ?? 0),
          websiteUrl: websiteRaw.startsWith('http') ? websiteRaw : undefined,
        };
      })
      .filter(Boolean) as RemoteSource[];
  } catch {
    return [];
  }
}

export function searchFeedlyByTopic(topicId: string, count = 12): Promise<RemoteSource[]> {
  return searchFeedly(TOPIC_QUERIES[topicId] ?? topicId, count);
}
