import sharp from "sharp";
import { resolve } from "node:path";
import { getShard, shards, type ShardId } from "../data/shards";
import {
  hashString,
  mulberry32,
  voronoiCells,
  rectPoly,
  insetPolygon,
} from "./geometry";
import { escapeXml } from "./sharing";

/** Build-time artwork: stable per URL, using the same geometry and colours as the site. */
export async function renderSocialImage(page: {
  title: string;
  description: string;
  shard?: ShardId;
  seed: string;
}): Promise<Buffer> {
  const rng = mulberry32(hashString(page.seed));
  const palette = page.shard ? [getShard(page.shard)] : shards;
  const sites = Array.from({ length: 24 }, () => ({
    x: rng() * 1200,
    y: rng() * 630,
  }));
  const polygons = voronoiCells(sites, rectPoly(1200, 630))
    .map((cell, i) => {
      const points = insetPolygon(cell, 4)
        .map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`)
        .join(" ");
      return `<polygon points="${points}" fill="#0c0c19" stroke="url(#seam${i % palette.length})" stroke-width="2"/>`;
    })
    .join("");
  const gradients = palette
    .map(
      (p, i) => `<linearGradient id="seam${i}" x2="1" y2="1">
    <stop stop-color="${p.edge[0]}"/><stop offset="1" stop-color="${p.edge[1]}"/>
  </linearGradient>`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><defs>
    ${gradients}<filter id="glow"><feGaussianBlur stdDeviation="9"/></filter>
    <linearGradient id="shade"><stop stop-color="#050510" stop-opacity=".97"/>
    <stop offset=".65" stop-color="#050510" stop-opacity=".86"/>
    <stop offset="1" stop-color="#050510" stop-opacity=".12"/></linearGradient>
    </defs><rect width="1200" height="630" fill="#050510"/>
    <g filter="url(#glow)">${polygons}</g>${polygons}
    <rect width="1200" height="630" fill="url(#shade)"/>
    <path d="M76 151H236L265 122" fill="none" stroke="${palette[0].edge[0]}" stroke-width="2"/>
  </svg>`;

  // Pango loads the checked-in fonts explicitly, so CI does not need system fonts.
  const text = async (
    value: string,
    font: "Syne" | "Lora",
    size: number,
    width: number,
    maxHeight: number,
    color: string,
  ) => {
    const fontfile = resolve(
      `public/fonts/${font}/${font}-VariableFont_wght.ttf`,
    );
    const rendered = await sharp({
      text: {
        text: `<span foreground="${color}">${escapeXml(value)}</span>`,
        font: `${font} ${size}`,
        fontfile,
        width,
        rgba: true,
        wrap: "word-char",
      },
    })
      .png()
      .toBuffer();
    return sharp(rendered)
      .resize({
        width,
        height: maxHeight,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
  };
  const section = page.shard
    ? `LEON LENK  /  ${getShard(page.shard).label.toUpperCase()}`
    : "WRITING · RESEARCH · THOUGHTS";
  const [label, title, description, footer] = await Promise.all([
    text(section, "Syne", 21, 1020, 36, "#c6c0d6"),
    text(page.title, "Lora", 66, 900, 214, "#ffffff"),
    page.description.trim()
      ? text(page.description, "Lora", 25, 790, 90, "#c6c0d6")
      : null,
    text("leonlenk.com", "Syne", 20, 500, 30, "#aaa2be"),
  ]);
  return sharp(Buffer.from(svg))
    .composite([
      { input: label, left: 76, top: 81 },
      { input: title, left: 76, top: 191 },
      ...(description ? [{ input: description, left: 76, top: 430 }] : []),
      { input: footer, left: 76, top: 555 },
    ])
    .png()
    .toBuffer();
}
