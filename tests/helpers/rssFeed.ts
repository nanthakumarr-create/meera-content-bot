/** Build a Google News-shaped RSS document for tests. */
export function feed(
  items: { title: string; source: string; date: string; link?: string; description?: string }[],
) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Google News</title>
${items
  .map(
    (i) => `<item>
  <title>${i.title} - ${i.source}</title>
  <link>${i.link ?? "https://news.google.com/rss/articles/abc"}</link>
  <pubDate>${i.date}</pubDate>
  <description>&lt;a href="https://x"&gt;${i.title}&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;${i.source}&lt;/font&gt; ${i.description ?? ""}</description>
  <source url="https://${i.source.toLowerCase().replace(/\s/g, "")}.com">${i.source}</source>
</item>`,
  )
  .join("\n")}
</channel></rss>`;
}
