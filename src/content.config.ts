import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const bookMeta = z.object({
  no: z.string(),
  title: z.string(),
  en: z.string(),
  pattern: z.enum(["pt-a", "pt-b", "pt-c"]),
  hue: z.string(),
  hue2: z.string(),
  cat: z.string(),
  level: z.string(),
  updated: z.string(),
  sub: z.string(),
  intro: z.string(),
  order: z.number(),
  draft: z.boolean().default(false),
  phases: z
    .array(
      z.object({
        name: z.string(),
        from: z.number(),
        to: z.number(),
      }),
    )
    .default([]),
});

const books = defineCollection({
  loader: glob({ pattern: "**/_book.md", base: "./content" }),
  schema: bookMeta,
});

const chapters = defineCollection({
  loader: glob({
    pattern: ["**/*.md", "!**/_*.md"],
    base: "./content",
  }),
  schema: z.object({
    title: z.string(),
    summary: z.string().optional().default(""),
    date: z.coerce.date().optional(),
    tags: z.array(z.string()).optional(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { books, chapters };
