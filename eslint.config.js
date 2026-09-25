import eslintPluginAstro from "eslint-plugin-astro";
import tseslint from "typescript-eslint";

export default [
  // The music engine keeps the prototype's compact style (see its header).
  {
    ignores: ["dist/", "dist-*/", ".astro/", "tools/music/cavern-engine.js"],
  },
  ...tseslint.configs.recommended,
  // Must come after typescript-eslint so the Astro parser wins for .astro files.
  ...eslintPluginAstro.configs.recommended,
];
