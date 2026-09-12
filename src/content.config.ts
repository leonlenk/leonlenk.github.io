import { defineCollection } from "astro:content";
import { file, glob } from "astro/loaders";
// Imported straight from zod, not re-exported from "astro:content" — that
// re-export is deprecated as of Astro 7. Astro resolves zod/v4 internally,
// which is the same module instance as this root import.
import { z } from "zod";
import { shardIds } from "./data/shards";

// Modern (non-legacy) content collections. Consume with:
//   const posts = await getCollection("posts");
//   const { Content } = await render(post);   // `render` from "astro:content"
// Entries are keyed by `post.id`, not the removed `post.slug`. Because the
// glob loader is rooted at src/content/posts, the shard directory is part of
// the id: writing/koala_poem.md → "writing/koala_poem". Routes strip that
// prefix (see src/lib/posts.ts).
const posts = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/posts" }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    shard: z.enum(shardIds),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
    author: z.string().default("Leon Lenk"),
  }),
});

// Academic papers live in one JSON array. The file loader keys each entry by
// its `id` field and passes the whole object through the schema, so `id` is
// both the entry key and a data field.
const papers = defineCollection({
  loader: file("./src/content/papers.json"),
  schema: z.object({
    id: z.string(),
    title: z.string(),
    authors: z.array(z.string()),
    venue: z.string(),
    year: z.number(),
    url: z.url(),
    type: z.enum(["journal", "conference", "preprint"]),
    // The author name to bold in the rendered author list.
    highlight: z.string().default("Leon Lenk"),
  }),
});

export const collections = { posts, papers };
