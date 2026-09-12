import eslintPluginAstro from "eslint-plugin-astro";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["dist/", ".astro/"] },
  ...tseslint.configs.recommended,
  // Must come after typescript-eslint so the Astro parser wins for .astro files.
  ...eslintPluginAstro.configs.recommended,
];
