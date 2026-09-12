import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// https://astro.build/config
export default defineConfig({
  site: "https://www.leonlenk.com",
  integrations: [sitemap()],
  build: {
    // Non-default asset dir so GitHub Pages never treats it as a Jekyll
    // underscore path.
    assets: "assets",
  },
  vite: {
    build: {
      minify: "terser",
      terserOptions: {
        compress: {
          drop_console: true,
          drop_debugger: true,
        },
      },
    },
  },
});
