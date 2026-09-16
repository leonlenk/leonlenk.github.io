import { getShard } from "../data/shards";
import type { Post } from "./posts";

export const siteDescription =
  "Writing, research, food, art, self, philosophy — one shard each.";

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
