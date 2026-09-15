import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { postHref } from "../lib/posts";
import { escapeXml, postDescription, siteDescription } from "../lib/sharing";

export const GET: APIRoute = async ({ site }) => {
  if (!site) throw new Error("RSS requires Astro's site URL");
  const posts = (await getCollection("posts", ({ data }) => !data.draft)).sort(
    (a, b) =>
      b.data.pubDate.valueOf() - a.data.pubDate.valueOf() ||
      a.id.localeCompare(b.id),
  );
  const items = posts
    .map((post) => {
      const url = escapeXml(new URL(postHref(post), site).href);
      return `<item>
      <title>${escapeXml(post.data.title)}</title>
      <link>${url}</link><guid isPermaLink="true">${url}</guid>
      <description>${escapeXml(postDescription(post))}</description>
      <pubDate>${post.data.pubDate.toUTCString()}</pubDate>
      <category>${escapeXml(post.data.shard)}</category>
    </item>`;
    })
    .join("\n");
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
      <title>Leon Lenk</title><link>${escapeXml(site.href)}</link>
      <description>${escapeXml(siteDescription)}</description><language>en</language>
      <atom:link href="${escapeXml(new URL("/rss.xml", site).href)}" rel="self" type="application/rss+xml"/>
      ${items}
    </channel></rss>`,
    { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } },
  );
};
