import { getCollection, type CollectionEntry } from "astro:content";

export type BookEntry = CollectionEntry<"books">;
export type ChapterEntry = CollectionEntry<"chapters">;

export type ChapterView = {
  entry: ChapterEntry;
  slug: string;
  idx: number;
  chars: number;
  minutes: number;
  words: number;
  path: string;
};

export type VolumeView = {
  title: string;
  order: number;
  chapters: ChapterView[];
};

export type BookView = {
  id: string;
  no: string;
  title: string;
  en: string;
  pattern: "pt-a" | "pt-b" | "pt-c";
  hue: string;
  hue2: string;
  cat: string;
  level: string;
  updated: string;
  sub: string;
  intro: string;
  order: number;
  path: string;
  total: number;
  words: number;
  chapters: ChapterView[];
  vols: VolumeView[];
};

export type ClientChapter = {
  slug: string;
  title: string;
  vol: string;
  summary: string;
  minutes: number;
  words: number;
  path: string;
};

export type ClientBook = {
  id: string;
  no: string;
  title: string;
  en: string;
  cat: string;
  level: string;
  hue: string;
  hue2: string;
  pattern: string;
  total: number;
  words: number;
  path: string;
  chapters: ClientChapter[];
};

export function bookIdFromEntry(entry: BookEntry) {
  return entry.id.replace(/\.md$/, "");
}

export function chapterSlug(entry: ChapterEntry) {
  const tail = entry.id.split("/").pop() ?? entry.id;
  return tail.replace(/\.md$/, "");
}

export function charCount(body: string) {
  return body.replace(/\s+/g, "").length;
}

export function estimateMinutes(chars: number) {
  return Math.max(5, Math.round(chars / 400));
}

export function pad(n: number) {
  return String(n + 1).padStart(2, "0");
}

export function bookPath(id: string) {
  return `/book/${id}/`;
}

export function chapterPath(book: string, slug: string) {
  return `/book/${book}/${slug}/`;
}

export function fmtWords(n: number) {
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万字`;
  return `${n.toLocaleString("zh-CN")} 字`;
}

export function todayLabel(date = new Date()) {
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日 · 周${"日一二三四五六"[date.getDay()]}`;
}

function toChapterView(entry: ChapterEntry, idx: number): ChapterView {
  const chars = charCount(entry.body);
  const slug = chapterSlug(entry);
  return {
    entry,
    slug,
    idx,
    chars,
    minutes: estimateMinutes(chars),
    words: chars,
    path: chapterPath(entry.data.book, slug),
  };
}

export async function loadLibrary(): Promise<BookView[]> {
  const books = (await getCollection("books", ({ data }) => !data.draft)).sort(
    (a, b) => a.data.order - b.data.order,
  );
  const chapters = (await getCollection("chapters", ({ data }) => !data.draft)).sort((a, b) => {
    if (a.data.book !== b.data.book) return a.data.book.localeCompare(b.data.book);
    if (a.data.volOrder !== b.data.volOrder) return a.data.volOrder - b.data.volOrder;
    return a.data.order - b.data.order;
  });

  const byBook = new Map<string, ChapterEntry[]>();
  for (const chapter of chapters) {
    const list = byBook.get(chapter.data.book) ?? [];
    list.push(chapter);
    byBook.set(chapter.data.book, list);
  }

  return books.map((book) => {
    const id = bookIdFromEntry(book);
    const list = byBook.get(id) ?? [];
    const views = list.map((chapter, idx) => toChapterView(chapter, idx));
    const volMap = new Map<string, ChapterView[]>();
    const volOrder = new Map<string, number>();
    for (const view of views) {
      const title = view.entry.data.vol;
      if (!volMap.has(title)) {
        volMap.set(title, []);
        volOrder.set(title, view.entry.data.volOrder);
      }
      volMap.get(title)!.push(view);
    }
    const vols: VolumeView[] = [...volMap.entries()]
      .map(([title, chs]) => ({
        title,
        order: volOrder.get(title) ?? 0,
        chapters: chs,
      }))
      .sort((a, b) => a.order - b.order);

    return {
      id,
      no: book.data.no,
      title: book.data.title,
      en: book.data.en,
      pattern: book.data.pattern,
      hue: book.data.hue,
      hue2: book.data.hue2,
      cat: book.data.cat,
      level: book.data.level,
      updated: book.data.updated,
      sub: book.data.sub,
      intro: book.data.intro,
      order: book.data.order,
      path: bookPath(id),
      total: views.length,
      words: views.reduce((sum, item) => sum + item.words, 0),
      chapters: views,
      vols,
    };
  });
}

export function toClientCatalog(books: BookView[]): ClientBook[] {
  return books.map((book) => ({
    id: book.id,
    no: book.no,
    title: book.title,
    en: book.en,
    cat: book.cat,
    level: book.level,
    hue: book.hue,
    hue2: book.hue2,
    pattern: book.pattern,
    total: book.total,
    words: book.words,
    path: book.path,
    chapters: book.chapters.map((chapter) => ({
      slug: chapter.slug,
      title: chapter.entry.data.title,
      vol: chapter.entry.data.vol,
      summary: chapter.entry.data.summary,
      minutes: chapter.minutes,
      words: chapter.words,
      path: chapter.path,
    })),
  }));
}

export function findBook(books: BookView[], id: string) {
  return books.find((book) => book.id === id) ?? null;
}

export function findChapter(book: BookView, slug: string) {
  return book.chapters.find((chapter) => chapter.slug === slug) ?? null;
}
