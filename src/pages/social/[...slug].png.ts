import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";
import { shards, type ShardId } from "../../data/shards";
import { postHref } from "../../lib/posts";
import { postDescription, siteDescription } from "../../lib/sharing";
import { renderSocialImage } from "../../lib/social-image";

interface Props {
  title: string;
  description: string;
  shard?: ShardId;
  seed: string;
}

export const getStaticPaths: GetStaticPaths = async () => {
  const posts = await getCollection("posts", ({ data }) => !data.draft);
  const selfPost = posts.find((post) => post.id === "self/about");
  return [
    {
      params: { slug: "home" },
      props: { title: "Leon Lenk", description: siteDescription, seed: "home" },
    },
    ...shards.map((shard) => ({
      params: { slug: shard.id },
      props: {
        title:
          shard.id === "self" && selfPost ? selfPost.data.title : shard.label,
        description:
          shard.id === "self" && selfPost
            ? postDescription(selfPost)
            : shard.tagline,
        shard: shard.id,
        seed: shard.id,
      },
    })),
    ...posts
      .filter(
        (post) => !shards.some((shard) => postHref(post) === `/${shard.id}/`),
      )
      .map((post) => ({
        params: { slug: postHref(post).slice(1, -1) },
        props: {
          title: post.data.title,
          description: postDescription(post),
          shard: post.data.shard,
          seed: post.id,
        },
      })),
  ];
};

export const GET: APIRoute = async ({ props }) => {
  const png = await renderSocialImage(props as Props);
  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png" },
  });
};
