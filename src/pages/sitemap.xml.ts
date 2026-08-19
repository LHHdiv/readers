import type { APIRoute } from "astro";
import { loadLibrary } from "../lib/catalog";

export const GET: APIRoute = async ({ site }) => {
  const origin = site ?? new URL("https://readers.netlify.app");
  const books = await loadLibrary();
  const paths = ["/", ...books.map((book) => book.path), ...books.flatMap((book) => book.chapters.map((chapter) => chapter.path))];
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths
  .map((path) => `  <url><loc>${new URL(path, origin).href}</loc></url>`)
  .join("\n")}
</urlset>
`;
  return new Response(body, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
};
