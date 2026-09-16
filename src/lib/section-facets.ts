import type { ShardId } from "../data/shards";

/** Large, open crystal planes. Each section has its own composition, with
 * the center left clear for headings and content. Coordinates are percentages. */
export const sectionFacets: Record<
  ShardId,
  {
    lines: string[];
    narrow: string[];
    light: string;
    shadeAngle: string;
    plane: string;
  }
> = {
  writing: {
    lines: [
      "M 29 -5 L 12 42 L -5 61",
      "M 12 42 L 3 105",
      "M 105 21 L 89 59 L 78 105",
    ],
    narrow: [
      "M 18 -5 L 2 42 L -5 55",
      "M 2 42 L -2 105",
      "M 105 41 L 97 68 L 91 105",
    ],
    light: "0% 42%",
    shadeAngle: "115deg",
    plane: "polygon(0 0, 29% 0, 12% 42%, 0 61%)",
  },
  research: {
    lines: [
      "M -5 23 L 17 9 L 24 -5",
      "M 17 9 L 4 105",
      "M 82 -5 L 94 36 L 105 43",
      "M 94 36 L 87 105",
    ],
    narrow: [
      "M -5 21 L 4 9 L 16 -5",
      "M 4 9 L -3 105",
      "M 90 -5 L 98 35 L 105 40",
    ],
    light: "100% 12%",
    shadeAngle: "225deg",
    plane: "polygon(82% 0, 100% 0, 100% 43%, 94% 36%)",
  },
  art: {
    lines: [
      "M 90 -5 L 82 48 L 94 105",
      "M 82 48 L 105 32",
      "M -5 67 L 10 78 L 19 105",
    ],
    narrow: [
      "M 99 -5 L 96 48 L 101 105",
      "M 96 48 L 105 37",
      "M -5 70 L 3 84 L 9 105",
    ],
    light: "100% 58%",
    shadeAngle: "255deg",
    plane: "polygon(90% 0, 100% 0, 100% 100%, 94% 100%, 82% 48%)",
  },
  food: {
    lines: [
      "M -5 40 L 11 72 L 31 105",
      "M 11 72 L -5 84",
      "M 105 57 L 88 82 L 62 105",
    ],
    narrow: [
      "M -5 47 L 3 77 L 14 105",
      "M 3 77 L -5 86",
      "M 105 62 L 97 86 L 87 105",
    ],
    light: "12% 100%",
    shadeAngle: "25deg",
    plane: "polygon(0 40%, 11% 72%, 31% 100%, 0 100%)",
  },
  self: {
    lines: [
      "M 13 -5 L 20 29 L -5 47",
      "M 20 29 L 6 105",
      "M 105 9 L 91 44 L 98 105",
    ],
    narrow: [
      "M 0 -5 L 5 27 L -5 43",
      "M 5 27 L -2 105",
      "M 105 10 L 98 49 L 103 105",
    ],
    light: "0% 18%",
    shadeAngle: "145deg",
    plane: "polygon(0 0, 13% 0, 20% 29%, 0 47%)",
  },
  philosophy: {
    lines: [
      "M -5 28 L 13 62 L 7 105",
      "M 13 62 L -5 77",
      "M 75 -5 L 89 28 L 105 35",
      "M 89 28 L 95 105",
    ],
    narrow: [
      "M -5 32 L 3 64 L 0 105",
      "M 3 64 L -5 75",
      "M 89 -5 L 97 27 L 105 32",
      "M 97 27 L 102 105",
    ],
    light: "100% 30%",
    shadeAngle: "205deg",
    plane: "polygon(75% 0, 100% 0, 100% 35%, 89% 28%)",
  },
};
