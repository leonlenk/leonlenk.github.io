// astro.config.mjs
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  site: "https://www.leonlenk.com",
  build: {
    assets: "assets",
  },
  vite: {
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['astro'],
          },
        },
      },
      // Enable tree shaking and minification
      minify: 'terser',
      terserOptions: {
        compress: {
          drop_console: true,
          drop_debugger: true,
        },
      },
    },
  },
  // Performance optimizations
  output: 'static',
});
