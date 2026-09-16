import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// https://astro.build/config
export default defineConfig({
  site: "https://www.leonlenk.com",
  trailingSlash: "always",
  integrations: [
    sitemap({
      // This legacy URL is a static redirect to /self/, not a canonical page.
      filter: (page) => new URL(page).pathname !== "/self/about/",
    }),
  ],
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
