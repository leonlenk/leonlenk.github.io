// Shard registry: the ordered, top-level sections of the site. Every post
// belongs to exactly one shard. The content schema, the routes and the
// palette all derive from this list, so adding a shard here is the only
// registration step.
//
// Colour lives only in a shard's glowing edges. Each shard is a gemstone and
// owns one slice of the "Geode" spectrum (aquamarine → sapphire → amethyst →
// rhodolite → rose garnet → citrine), expressed as two gradient stops at two
// intensities:
//   deep — muted; sits under text on that shard's pages.
//   edge — lifted; carries light against the nebula.

/** A two-stop gradient, start → end, as sRGB hex. */
type Stops = readonly [string, string];

interface ShardDefinition {
  /** URL slug — becomes the first path segment, e.g. `/writing/`. */
  id: string;
  /** Display name. */
  label: string;
  /** Muted gradient stops for surfaces that carry text. */
  deep: Stops;
  /** Lifted gradient stops for seams and glow. */
  edge: Stops;
  /** Position in navigation; mirrors array order. */
  order: number;
}

export const shards = [
  {
    id: "writing",
    label: "Writing",
    deep: ["#1c595c", "#203968"],
    edge: ["#43d5dc", "#4c87f8"],
    order: 1,
  },
  {
    id: "research",
    label: "Research",
    deep: ["#203968", "#473266"],
    edge: ["#4c87f8", "#a876f2"],
    order: 2,
  },
  {
    id: "food",
    label: "Food",
    deep: ["#673a21", "#675214"],
    edge: ["#f68a4f", "#f6c330"],
    order: 3,
  },
  {
    id: "art",
    label: "Art",
    deep: ["#642a34", "#673a21"],
    edge: ["#ed647c", "#f68a4f"],
    order: 4,
  },
  {
    id: "self",
    label: "Self",
    deep: ["#473266", "#5e2951"],
    edge: ["#a876f2", "#df61c0"],
    order: 5,
  },
  {
    id: "ai",
    label: "AI",
    deep: ["#5e2951", "#642a34"],
    edge: ["#df61c0", "#ed647c"],
    order: 6,
  },
] as const satisfies readonly ShardDefinition[];

/** One entry of the registry, with literal `id`. */
export type Shard = (typeof shards)[number];

/** Union of every shard id: "writing" | "research" | ... */
export type ShardId = Shard["id"];

// Split off the head so `as const` below yields a non-empty readonly tuple
// (`readonly [ShardId, ...ShardId[]]`) without a cast.
const [firstId, ...restIds] = shards.map((shard) => shard.id);

/**
 * Readonly tuple of ids in shard order. Feeds `z.enum(shardIds)` in the
 * content config so a post's `shard` field is validated against the registry.
 */
export const shardIds = [firstId, ...restIds] as const;

/** Look up a shard by id. A `ShardId` always resolves; an arbitrary string may not. */
export function getShard(id: ShardId): Shard;
export function getShard(id: string): Shard | undefined;
export function getShard(id: string): Shard | undefined {
  return shards.find((shard) => shard.id === id);
}

// --- CSS custom properties ------------------------------------------------

/** "#rrggbb" → [r, g, b] in 0–255. */
function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** [r, g, b] in 0–255 → "#rrggbb". */
function rgbToHex([r, g, b]: [number, number, number]): string {
  const channel = (v: number) =>
    Math.round(Math.max(0, Math.min(255, v)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** Straight sRGB midpoint of two hex colours — no gamma correction, by design. */
export function midpoint(a: string, b: string): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex([(ar + br) / 2, (ag + bg) / 2, (ab + bb) / 2]);
}

/**
 * The palette as CSS, meant for an inline `<style>` in the document head so
 * the tokens exist before first paint.
 *
 * `:root` declares every stop by shard: `--shard-<id>-deep-0/1` and
 * `--shard-<id>-edge-0/1`. Then each `[data-shard="<id>"]` scope sets the
 * unscoped aliases `--shard-deep-0/1`, `--shard-edge-0/1` and `--shard-mid`
 * (the sRGB midpoint of the two edge stops). Components read the aliases, so
 * anything inside a `data-shard` element — including the whole page when the
 * layout stamps it on `<html>` — picks up its shard's colour for free.
 */
export function shardCss(): string {
  const root = shards
    .flatMap(({ id, deep, edge }) => [
      `--shard-${id}-deep-0:${deep[0]};`,
      `--shard-${id}-deep-1:${deep[1]};`,
      `--shard-${id}-edge-0:${edge[0]};`,
      `--shard-${id}-edge-1:${edge[1]};`,
    ])
    .join("");

  const scopes = shards
    .map(
      ({ id, edge }) =>
        `[data-shard="${id}"]{` +
        `--shard-deep-0:var(--shard-${id}-deep-0);` +
        `--shard-deep-1:var(--shard-${id}-deep-1);` +
        `--shard-edge-0:var(--shard-${id}-edge-0);` +
        `--shard-edge-1:var(--shard-${id}-edge-1);` +
        `--shard-mid:${midpoint(edge[0], edge[1])};` +
        `}`,
    )
    .join("");

  return `:root{${root}}${scopes}`;
}
