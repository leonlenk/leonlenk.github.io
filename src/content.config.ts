import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

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
