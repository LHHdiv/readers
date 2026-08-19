import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const books = defineCollection({
  loader: glob({ pattern: "**/[^_]*.md", base: "./content/books" }),
  schema: z.object({
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
  }),
});

const chapters = defineCollection({
  loader: glob({ pattern: "**/[^_]*.md", base: "./content/chapters" }),
  schema: z.object({
    book: z.string(),
    vol: z.string(),
    volOrder: z.number(),
    order: z.number(),
    title: z.string(),
    summary: z.string(),
    points: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

const journal = defineCollection({
  loader: glob({ pattern: "**/[^_]*.md", base: "./content/journal" }),
  schema: z.object({
    date: z.string(),
    title: z.string(),
    image: z.string(),
    order: z.number(),
  }),
});

export const collections = { books, chapters, journal };
