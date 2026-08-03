import { NextResponse } from 'next/server';

export const revalidate = 300; // 5-minute cache

export interface NewsArticle {
  id: string;
  title: string;
  url: string;
  source: string;
  imageUrl: string;
  publishedAt: number; // unix seconds
  categories: string[];
  body: string;
}

const FEEDS = [
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss', source: 'CoinDesk', category: 'Blockchain' },
  { url: 'https://cointelegraph.com/rss', source: 'CoinTelegraph', category: 'Crypto' },
  { url: 'https://decrypt.co/feed', source: 'Decrypt', category: 'Web3' },
];

// Regex parsing rather than an XML library. These are three known feeds whose shape
// does not vary, the payload is read-only and never rendered as markup, and the
// alternative is a dependency for one route. It is not a general RSS parser: a feed
// outside FEEDS would likely need its own handling.
function extractTag(xml: string, tag: string): string {
  // CDATA is tried first because a title wrapped in CDATA also matches the plain
  // pattern, and the plain match would return the CDATA wrapper as part of the text.
  const cdataRe = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i');
  const plainRe = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const cdata = cdataRe.exec(xml);
  if (cdata) return cdata[1].trim();
  const plain = plainRe.exec(xml);
  return plain ? plain[1].replace(/<[^>]+>/g, '').trim() : '';
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, 'i');
  const m = re.exec(xml);
  return m ? m[1] : '';
}

function parseRss(xml: string, source: string, defaultCategory: string): NewsArticle[] {
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  const articles: NewsArticle[] = [];
  let match;

  while ((match = itemRe.exec(xml)) !== null) {
    const chunk = match[1];
    const title = extractTag(chunk, 'title');
    const url = extractTag(chunk, 'link') || extractAttr(chunk, 'link', 'href') || extractTag(chunk, 'guid');
    const description = extractTag(chunk, 'description') || extractTag(chunk, 'content:encoded') || '';
    const pubDateStr = extractTag(chunk, 'pubDate') || extractTag(chunk, 'dc:date') || '';
    const imageUrl =
      extractAttr(chunk, 'media:content', 'url') ||
      extractAttr(chunk, 'media:thumbnail', 'url') ||
      extractAttr(chunk, 'enclosure', 'url') ||
      (() => {
        const imgMatch = /<img[^>]+src="([^"]+)"/i.exec(description);
        return imgMatch ? imgMatch[1] : '';
      })();
    const categories = [defaultCategory];
    const cat = extractTag(chunk, 'category');
    if (cat && cat !== defaultCategory) categories.push(cat.split('/').pop()?.trim() ?? cat);

    // An item with no title or no link is unusable in the UI, and a headline that
    // renders as an empty card is worse than one article fewer.
    if (!title || !url) continue;

    const publishedAt = pubDateStr ? Math.floor(new Date(pubDateStr).getTime() / 1000) : Math.floor(Date.now() / 1000);

    articles.push({
      id: url,
      title,
      url,
      source,
      imageUrl,
      publishedAt,
      categories: categories.slice(0, 2),
      body: description.replace(/<[^>]+>/g, '').slice(0, 160),
    });
  }

  return articles;
}

export async function GET() {
  // allSettled, not all: one feed being down or slow must not empty the news panel.
  // Whatever came back is used, and the short timeout bounds how long a hanging feed
  // can delay the other two.
  const results = await Promise.allSettled(
    FEEDS.map(async ({ url, source, category }) => {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'NexusFi/1.0 (+https://nexusfi.app)', 'Accept': 'application/rss+xml, application/xml, text/xml' },
        signal: AbortSignal.timeout(6000),
        next: { revalidate: 300 },
      });
      if (!res.ok) throw new Error(`${source} feed returned ${res.status}`);
      const xml = await res.text();
      return parseRss(xml, source, category);
    })
  );

  const all: NewsArticle[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value);
  }

  // Sort newest first, de-dupe by url, take top 25
  // Sorted before de-duping, so when the same URL appears in two feeds the copy that
  // survives is the one carrying the later timestamp rather than whichever feed
  // happened to resolve first.
  const seen = new Set<string>();
  const articles = all
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .filter((a) => {
      if (seen.has(a.url)) return false;
      seen.add(a.url);
      return true;
    })
    .slice(0, 25);

  return NextResponse.json({ articles, fetchedAt: Date.now() });
}
