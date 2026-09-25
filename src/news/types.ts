export interface NewsItem {
  headline: string;
  publication: string | null;
  publishedAt: Date | null;
  url: string;
  /** Plain-text RSS description. We never fetch or claim to have read the article body. */
  description: string;
}

export interface NewsCacheStore {
  getNewsCache(key: string, now: Date): Promise<NewsItem[] | null>;
  putNewsCache(key: string, query: string, items: NewsItem[], expiresAt: Date): Promise<void>;
}

export interface NewsService {
  findCandidates(keywords: string[]): Promise<NewsItem[]>;
}
