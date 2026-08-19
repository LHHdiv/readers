import { getCollection, type CollectionEntry } from "astro:content";

export type BookEntry = CollectionEntry<"books">;
export type ChapterEntry = CollectionEntry<"chapters">;

export type ChapterView = {
  entry: ChapterEntry;
  slug: string;
  idx: number;
  order: number;
  title: string;
  summary: string;
  vol: string;
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
  return entry.id.split("/")[0]?.replace(/\.md$/, "") ?? entry.id;
}

export function chapterBookId(entry: ChapterEntry) {
  return entry.id.split("/")[0] ?? "";
}

export function chapterSlug(entry: ChapterEntry) {
  const tail = entry.id.split("/").pop() ?? entry.id;
  return tail.replace(/\.md$/, "");
}

export function chapterOrder(entry: ChapterEntry) {
  const name = chapterSlug(entry);
  const match = name.match(/^(\d+)/);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

export function cleanTitle(title: string) {
  return title.replace(/^第\s*\d+\s*章\s*[·.•\-\u2014\u2013]\s*/, "").trim();
}

export function charCount(body: string) {
  return body.replace(/\s+/g, "").length;
}

export function estimateMinutes(chars: number) {
  return Math.max(5, Math.round(chars / 400));
}

export function pad(n: number) {
  return String(n).padStart(2, "0");
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

function volumeFor(order: number, phases: { name: string; from: number; to: number }[]) {
  if (!phases.length) return { name: "正文", index: 1 };
  const index = phases.findIndex((phase) => order >= phase.from && order <= phase.to);
  if (index === -1) {
    return { name: phases[phases.length - 1].name, index: phases.length };
  }
  return { name: phases[index].name, index: index + 1 };
}

export async function loadLibrary(): Promise<BookView[]> {
  const books = (await getCollection("books", ({ data }) => !data.draft)).sort(
    (a, b) => a.data.order - b.data.order,
  );
  const chapters = await getCollection("chapters", ({ data }) => !data.draft);

  return books.map((book) => {
    const id = bookIdFromEntry(book);
    const list = chapters
      .filter((chapter) => chapterBookId(chapter) === id)
      .sort((a, b) => chapterOrder(a) - chapterOrder(b));

    const views: ChapterView[] = list.map((entry, idx) => {
      const order = chapterOrder(entry);
      const volume = volumeFor(order, book.data.phases);
      const chars = charCount(entry.body);
      const slug = chapterSlug(entry);
      const title = cleanTitle(entry.data.title);
      return {
        entry,
        slug,
        idx,
        order,
        title,
        summary: entry.data.summary || title,
        vol: volume.name,
        chars,
        minutes: estimateMinutes(chars),
        words: chars,
        path: chapterPath(id, slug),
      };
    });

    const volMap = new Map<string, ChapterView[]>();
    const volOrder = new Map<string, number>();
    for (const view of views) {
      const phase = volumeFor(view.order, book.data.phases);
      if (!volMap.has(view.vol)) {
        volMap.set(view.vol, []);
        volOrder.set(view.vol, phase.index);
      }
      volMap.get(view.vol)!.push(view);
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
      title: chapter.title,
      vol: chapter.vol,
      summary: chapter.summary,
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
