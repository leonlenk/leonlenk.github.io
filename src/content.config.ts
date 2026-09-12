import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
// Imported straight from zod, not re-exported from "astro:content" — that
// re-export is deprecated as of Astro 7. Astro resolves zod/v4 internally,
// which is the same module instance as this root import.
import { z } from "zod";

// Modern (non-legacy) content collections. Consume with:
//   const posts = await getCollection("blog");
//   const { Content } = await render(post);   // `render` from "astro:content"
// Entries are keyed by `post.id`, not the removed `post.slug`.
const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    pubDate: z.coerce.date(),
    author: z.string(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
