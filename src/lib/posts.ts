import type { CollectionEntry } from "astro:content";

export type Post = CollectionEntry<"posts">;

/**
 * Route segment for a post. Entry ids include the shard directory
 * ("writing/koala_poem"); the URL puts the shard first on its own, so the
 * prefix is stripped here. A post whose directory disagrees with its
 * frontmatter `shard` is a content error, so fail the build loudly instead
 * of minting a surprising URL.
 */
export function postSlug(post: Post): string {
  const prefix = `${post.data.shard}/`;
  if (!post.id.startsWith(prefix)) {
    throw new Error(
      `Post "${post.id}" declares shard "${post.data.shard}" but does not live in src/content/posts/${post.data.shard}/. Move the file or fix its frontmatter.`,
    );
  }
  return post.id.slice(prefix.length);
}

/** Canonical URL path for a post, with the trailing slash the build format uses. */
export function postHref(post: Post): string {
  if (post.id === "self/about") return "/self/";
  return `/${post.data.shard}/${postSlug(post)}/`;
}

const longDate = new Intl.DateTimeFormat("en-US", {
  dateStyle: "long",
  timeZone: "UTC",
});

/** "August 25, 2026" — formatted in UTC so YAML dates don't drift by a day. */
export function formatDate(date: Date): string {
  return longDate.format(date);
}

/** "2026-08-25" — for `<time datetime>`. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Typographic quotes for frontmatter strings, which smartypants never sees
 * (it only touches the markdown body). Apostrophes and closing quotes follow
 * a letter, digit or closing punctuation; everything else opens.
 * "Why I've become an AI 'Doomer'" → "Why I’ve become an AI ‘Doomer’".
 */
export function smartQuotes(text: string): string {
  return text
    .replace(/(^|[\s([{—–-])"/g, "$1“")
    .replace(/"/g, "”")
    .replace(/'(?=\d\ds\b)/g, "’")
    .replace(/(^|[\s([{—–-])'/g, "$1‘")
    .replace(/'/g, "’");
}
