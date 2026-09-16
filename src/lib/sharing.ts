import { getShard, type ShardId } from "../data/shards";
import type { Post } from "./posts";

export const siteDescription =
  "Leon Lenk's personal website: research papers, poetry, drawings, and reflections on learning and life.";

export const sectionDescriptions: Record<ShardId, string> = {
  writing:
    "Original poems and limericks by Leon Lenk, from koalas to Boltzmann brains.",
  research:
    "Research papers coauthored by Leon Lenk on machine learning, computational imaging, and optics.",
  food: "The food section of Leon Lenk's personal website. New posts are still to come.",
  art: "Drawings and reflections by Leon Lenk on learning to draw, from early sketches to figure studies and color practice.",
  self: "About Leon Lenk and the interests behind his personal website.",
  ai: "The AI section of Leon Lenk's personal website, for writing about artificial intelligence. New posts are still to come.",
};

export function escapeXml(value: string): string {
  return value.replace(
    /[<>&"']/g,
    (char) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[char]!,
  );
}

/** Shared by metadata, the feed, and generated artwork. */
export function postDescription(post: Post): string {
  return (
    post.data.description ||
    `${post.data.title} — ${getShard(post.data.shard).label.toLowerCase()} by Leon Lenk.`
  );
}

export function socialImagePath(pathname: string): string {
  const slug = pathname.replace(/^\/+|\/+$/g, "") || "home";
  return `/social/${slug}.png`;
}
