// @ts-check
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://readers.netlify.app",
  trailingSlash: "always",
  devToolbar: { enabled: false },
  markdown: {
    shikiConfig: {
      theme: "houston",
      wrap: true,
    },
  },
});
