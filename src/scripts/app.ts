import { site } from "../site.config";
import type { ClientBook } from "../lib/catalog";

type State = {
  theme: "light" | "dark";
  fs: number;
  done: Record<string, string[]>;
  last: { b: string; s: string } | null;
  first: number;
};

const KEY = site.storageKey;
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

function loadCatalog(): ClientBook[] {
  const node = document.getElementById("catalog-data");
  if (!node?.textContent) return [];
  try {
    return JSON.parse(node.textContent) as ClientBook[];
  } catch {
    return [];
  }
}

function loadState(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<State>;
      if (parsed && typeof parsed === "object") {
        return {
          theme:
            parsed.theme === "dark" || parsed.theme === "light"
              ? parsed.theme
              : matchMedia("(prefers-color-scheme: dark)").matches
                ? "dark"
                : "light",
          fs: typeof parsed.fs === "number" ? parsed.fs : 1,
          done: parsed.done ?? {},
          last: parsed.last ?? null,
          first: parsed.first ?? Date.now(),
        };
      }
    }
  } catch {
    /* ignore */
  }
  return {
    theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    fs: 1,
    done: {},
    last: null,
    first: Date.now(),
  };
}

let state = loadState();
const catalog = loadCatalog();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* ignore quota */
  }
}

function isDone(bookId: string, slug: string) {
  return (state.done[bookId] ?? []).includes(slug);
}

function setDone(bookId: string, slug: string, value: boolean) {
  const next = new Set(state.done[bookId] ?? []);
  if (value) next.add(slug);
  else next.delete(slug);
  state.done[bookId] = [...next];
  save();
}

function bookById(id: string) {
  return catalog.find((book) => book.id === id) ?? null;
}

function chapterBySlug(book: ClientBook, slug: string) {
  return book.chapters.find((chapter) => chapter.slug === slug) ?? null;
}

function nextUnread(book: ClientBook) {
  return book.chapters.find((chapter) => !isDone(book.id, chapter.slug)) ?? book.chapters[0] ?? null;
}

function statusOf(book: ClientBook) {
  const done = book.chapters.filter((chapter) => isDone(book.id, chapter.slug)).length;
  if (done === 0) return "未开卷";
  if (done >= book.total) return "已读完";
  return "在读";
}

function toast(text: string) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = text;
  el.classList.add("show");
  window.setTimeout(() => el.classList.remove("show"), 2400);
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  const moon = document.getElementById("icoMoon");
  const sun = document.getElementById("icoSun");
  if (moon) moon.hidden = state.theme === "dark";
  if (sun) sun.hidden = state.theme !== "dark";
}

function applyFs() {
  document.documentElement.style.setProperty("--prose-fs", `${16 + state.fs * 1.4}px`);
}

function lastLocation() {
  if (state.last) {
    const book = bookById(state.last.b);
    const chapter = book ? chapterBySlug(book, state.last.s) : null;
    if (book && chapter) return { book, chapter, idx: book.chapters.indexOf(chapter) };
  }
  const book = catalog[0];
  const chapter = book?.chapters[0];
  if (!book || !chapter) return null;
  return { book, chapter, idx: 0 };
}

function hydrateProgress() {
  const streak = Math.max(1, Math.floor((Date.now() - state.first) / 864e5) + 1);
  document.querySelectorAll("[data-streak]").forEach((el) => {
    el.textContent = String(streak);
  });

  let allDone = 0;
  let allWords = 0;
  for (const book of catalog) {
    const doneChapters = book.chapters.filter((chapter) => isDone(book.id, chapter.slug));
    const done = doneChapters.length;
    const pct = book.total ? Math.round((done / book.total) * 100) : 0;
    allDone += done;
    allWords += doneChapters.reduce((sum, chapter) => sum + chapter.words, 0);

    document.querySelectorAll(`[data-status="${book.id}"]`).forEach((el) => {
      el.textContent = statusOf(book);
    });
    document.querySelectorAll(`[data-done-count="${book.id}"]`).forEach((el) => {
      el.textContent = String(done);
    });
    document.querySelectorAll(`[data-bar-pct="${book.id}"]`).forEach((el) => {
      el.textContent = `${pct}%`;
    });
    document.querySelectorAll<HTMLElement>(`[data-bar="${book.id}"]`).forEach((el) => {
      el.dataset.w = String(pct);
      el.style.width = `${pct}%`;
    });
    document.querySelectorAll<HTMLElement>(`[data-spine="${book.id}"]`).forEach((el) => {
      el.dataset.h = String(pct);
      el.style.height = `${pct}%`;
    });

    const next = nextUnread(book);
    const label = done === 0 ? "开始学习" : done >= book.total ? "重温全书" : `继续阅读 · 第 ${(book.chapters.indexOf(next!) + 1)} 讲`;
    document.querySelectorAll<HTMLAnchorElement>(`[data-book-cta="${book.id}"]`).forEach((el) => {
      if (next) el.href = next.path;
      el.textContent = label;
    });

    for (const chapter of book.chapters) {
      const row = document.querySelector(`[data-ch="${book.id}:${chapter.slug}"]`);
      if (!row) continue;
      const current = state.last?.b === book.id && state.last.s === chapter.slug && !isDone(book.id, chapter.slug);
      row.classList.remove("done", "cur", "todo");
      row.classList.add(isDone(book.id, chapter.slug) ? "done" : current ? "cur" : "todo");
    }
  }

  document.querySelectorAll<HTMLElement>("[data-vol-book]").forEach((el) => {
    const id = el.dataset.volBook;
    const slugs = (el.dataset.volSlugs ?? "").split(",").filter(Boolean);
    if (!id) return;
    el.textContent = String(slugs.filter((slug) => isDone(id, slug)).length);
  });

  document.querySelectorAll<HTMLElement>("[data-ledger-done]").forEach((el) => {
    el.dataset.to = String(allDone);
    el.textContent = String(allDone);
  });
  document.querySelectorAll<HTMLElement>("[data-ledger-words]").forEach((el) => {
    const k = Math.round(allWords / 1000);
    el.dataset.to = String(k);
    el.textContent = String(k);
  });

  const last = lastLocation();
  if (!last) return;
  const { book, chapter, idx } = last;
  const cover = document.querySelector<HTMLAnchorElement>("[data-resume-cover]");
  const title = document.querySelector("[data-resume-title]");
  const sub = document.querySelector("[data-resume-sub]");
  const lede = document.querySelector("[data-resume-x]");
  if (cover) {
    cover.href = chapter.path;
    cover.setAttribute("aria-label", `继续阅读 ${book.title}`);
  }
  if (title) title.textContent = `《${book.title}》第 ${idx + 1} 讲 · ${chapter.title}`;
  if (sub) {
    sub.textContent = `${chapter.vol} · 约 ${chapter.minutes} 分钟 · ${(chapter.words / 1000).toFixed(1)}k 字`;
  }
  if (lede) lede.textContent = chapter.summary;
  document.querySelectorAll<HTMLAnchorElement>("[data-resume-go]").forEach((el) => {
    el.href = chapter.path;
    if (el.classList.contains("btn-solid") && el.closest(".resume-cta")) {
      el.textContent = `翻到第 ${idx + 1} 讲`;
    }
  });
}

function bindReveal() {
  const nodes = document.querySelectorAll<HTMLElement>(".rv:not(.in), .scr");
  if (reduce) {
    nodes.forEach((el) => {
      el.classList.add("in");
      if (el.classList.contains("scr")) el.textContent = el.dataset.text ?? el.textContent;
    });
    document.querySelectorAll<HTMLElement>("[data-w]").forEach((el) => {
      el.style.width = `${el.dataset.w ?? 0}%`;
    });
    document.querySelectorAll<HTMLElement>("[data-h]").forEach((el) => {
      el.style.height = `${el.dataset.h ?? 0}%`;
    });
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        el.classList.add("in");
        if (el.classList.contains("scr")) scramble(el);
        el.querySelectorAll<HTMLElement>(".cnt").forEach(runCounter);
        if (el.classList.contains("cnt")) runCounter(el);
        el.querySelectorAll<HTMLElement>("[data-w]").forEach((bar) => {
          bar.style.width = `${bar.dataset.w ?? 0}%`;
        });
        el.querySelectorAll<HTMLElement>("[data-h]").forEach((fill) => {
          fill.style.height = `${fill.dataset.h ?? 0}%`;
        });
        io.unobserve(el);
      }
    },
    { threshold: 0.14 },
  );
  nodes.forEach((el) => io.observe(el));
}

function scramble(el: HTMLElement) {
  const text = el.dataset.text ?? el.textContent ?? "";
  if (reduce) {
    el.textContent = text;
    return;
  }
  const chars = "ABCDEFGHKMNPRSTWX#/\\<>+";
  let frame = 0;
  const timer = window.setInterval(() => {
    frame += 1;
    el.textContent = text
      .split("")
      .map((ch, i) => (i < frame ? ch : ch === " " ? " " : chars[(Math.random() * chars.length) | 0]))
      .join("");
    if (frame >= text.length) {
      window.clearInterval(timer);
      el.textContent = text;
    }
  }, 26);
}

function runCounter(el: HTMLElement) {
  if (el.dataset.counted === "1") return;
  el.dataset.counted = "1";
  const to = Number(el.dataset.to ?? 0);
  if (reduce) {
    el.textContent = to.toLocaleString("zh-CN");
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const k = Math.min(1, (now - start) / 1300);
    const eased = 1 - (1 - k) ** 3;
    el.textContent = Math.round(to * eased).toLocaleString("zh-CN");
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function filterLib() {
  const query = (document.getElementById("libQ") as HTMLInputElement | null)?.value.trim().toLowerCase() ?? "";
  const active = document.querySelector<HTMLElement>(".chip.on");
  const cat = active?.dataset.cat ?? "全部";
  let shown = 0;
  document.querySelectorAll<HTMLElement>(".bcard").forEach((card) => {
    const ok =
      (cat === "全部" || card.dataset.cat === cat) &&
      (!query || (card.dataset.q ?? "").includes(query));
    card.classList.toggle("hide", !ok);
    if (ok) shown += 1;
  });
  const empty = document.getElementById("libEmpty");
  if (empty) empty.style.display = shown ? "none" : "block";
}

function wrapCodeBlocks() {
  document.querySelectorAll("#artBody pre").forEach((pre, index) => {
    if (pre.closest("figure.code")) return;
    const figure = document.createElement("figure");
    figure.className = "code";
    const caption = document.createElement("figcaption");
    const lang = pre.querySelector("code")?.className.match(/language-([a-z0-9]+)/i)?.[1] ?? "text";
    const id = `cb${index + 1}`;
    pre.id = id;
    caption.innerHTML = `<span class="dot"></span><span>${lang}</span><button class="copy" data-copy="${id}" type="button">复制</button>`;
    pre.replaceWith(figure);
    figure.append(caption, pre);
  });
}

function bindReader() {
  const prose = document.getElementById("prose");
  if (!prose) return;
  const bookId = prose.dataset.book;
  const slug = prose.dataset.slug;
  if (!bookId || !slug) return;

  state.last = { b: bookId, s: slug };
  save();
  wrapCodeBlocks();

  const markBtn = document.getElementById("markBtn");
  const stamp = document.getElementById("doneStamp");
  const syncMark = () => {
    const done = isDone(bookId, slug);
    if (markBtn) markBtn.textContent = done ? "撤销已读标记" : "标记为已读";
    if (stamp) stamp.innerHTML = done ? '<span class="stamp">已读</span>' : "";
  };
  syncMark();
  markBtn?.addEventListener("click", () => {
    const next = !isDone(bookId, slug);
    setDone(bookId, slug, next);
    syncMark();
    hydrateProgress();
    toast(next ? "已标记为已读" : "已撤销标记");
  });

  const heads = [...document.querySelectorAll<HTMLElement>("#artBody h2, #artBody h3")];
  const tocLinks = [...document.querySelectorAll<HTMLAnchorElement>("#rtocLinks a")];
  let autoShown = false;
  const onScroll = () => {
    const rect = prose.getBoundingClientRect();
    const total = rect.height - innerHeight;
    const p = Math.max(0, Math.min(1, -rect.top / Math.max(1, total)));
    const pct = Math.round(p * 100);
    const bar = document.getElementById("rprog");
    const label = document.getElementById("rtocPct");
    if (bar) bar.style.width = `${pct}%`;
    if (label) label.textContent = `${pct}%`;
    if (pct >= 85 && !isDone(bookId, slug)) {
      setDone(bookId, slug, true);
      syncMark();
      hydrateProgress();
      if (!autoShown) {
        const book = bookById(bookId);
        const chapter = book ? chapterBySlug(book, slug) : null;
        toast(`已读完 · 「${chapter?.title ?? "本讲"}」收入书架`);
        autoShown = true;
      }
    }
    let active: string | null = null;
    heads.forEach((heading) => {
      if (heading.getBoundingClientRect().top < 130) active = heading.id;
    });
    tocLinks.forEach((link) => {
      const href = link.getAttribute("href") ?? "";
      link.classList.toggle("on", href === `#${active}`);
    });
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

function bindPalette() {
  const pal = document.getElementById("pal");
  const input = document.getElementById("palInput") as HTMLInputElement | null;
  const list = document.getElementById("palList");
  if (!pal || !input || !list) return;

  const index = catalog.flatMap((book) =>
    book.chapters.map((chapter) => ({ book, chapter })),
  );
  let selected = 0;
  let rows = index;

  const close = () => {
    pal.hidden = true;
  };
  const open = () => {
    pal.hidden = false;
    input.value = "";
    draw("");
    window.setTimeout(() => input.focus(), 30);
  };
  const draw = (query: string) => {
    const q = query.trim().toLowerCase();
    selected = 0;
    rows = q
      ? index
          .filter(({ book, chapter }) =>
            `${chapter.title}${chapter.summary}${book.title}${book.cat}`.toLowerCase().includes(q),
          )
          .slice(0, 12)
      : index.filter(({ book, chapter }) => isDone(book.id, chapter.slug)).slice(-6).reverse();
    if (!q && rows.length === 0) rows = index.slice(0, 8);
    list.innerHTML = rows.length
      ? rows
          .map(
            ({ book, chapter }, i) =>
              `<a class="pal-it${i === 0 ? " on" : ""}" href="${chapter.path}" role="option">
                <span class="pal-dot" style="background:${book.hue}"></span>
                <span class="pal-t"><b>${chapter.title}</b><span>${book.title} · ${chapter.vol}</span></span>
                <span class="pal-k">${String(book.chapters.indexOf(chapter) + 1).padStart(2, "0")} / ${book.total}</span>
              </a>`,
          )
          .join("")
      : `<div class="pal-none">未找到相关章节。</div>`;
  };
  const move = (delta: number) => {
    const items = [...list.querySelectorAll(".pal-it")];
    if (!items.length) return;
    selected = (selected + delta + items.length) % items.length;
    items.forEach((el, i) => el.classList.toggle("on", i === selected));
    items[selected].scrollIntoView({ block: "nearest" });
  };

  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-pal]")) {
      event.preventDefault();
      pal.hidden ? open() : close();
    }
  });
  pal.addEventListener("click", (event) => {
    if (event.target === pal) close();
  });
  input.addEventListener("input", () => draw(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter") {
      const item = list.querySelectorAll<HTMLAnchorElement>(".pal-it")[selected];
      if (item) {
        event.preventDefault();
        location.href = item.href;
      }
    }
  });

  document.addEventListener("keydown", (event) => {
    const typing = /input|textarea|select/i.test((event.target as HTMLElement)?.tagName ?? "");
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      pal.hidden ? open() : close();
      return;
    }
    if (event.key === "Escape" && !pal.hidden) {
      close();
      return;
    }
    if (typing) return;
    if (event.key === "/") {
      event.preventDefault();
      open();
    }
  });
}

function bindChrome() {
  const toggle = document.getElementById("navToggle");
  const nav = document.getElementById("tnav");
  toggle?.addEventListener("click", () => {
    const open = nav?.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(!!open));
    toggle.textContent = open ? "关闭" : "菜单";
  });
  nav?.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      nav.classList.remove("open");
      toggle?.setAttribute("aria-expanded", "false");
      if (toggle) toggle.textContent = "菜单";
    });
  });

  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const copy = target.closest<HTMLElement>("[data-copy]");
    if (copy) {
      const pre = document.getElementById(copy.dataset.copy ?? "");
      if (pre) {
        navigator.clipboard
          ?.writeText(pre.textContent ?? "")
          .then(() => toast("代码已复制"))
          .catch(() => toast("复制失败"));
      }
      return;
    }
    if (target.closest("[data-theme]")) {
      state.theme = state.theme === "dark" ? "light" : "dark";
      save();
      applyTheme();
      return;
    }
    const fs = target.closest<HTMLElement>("[data-fs]");
    if (fs) {
      state.fs = Math.max(0, Math.min(4, state.fs + Number(fs.dataset.fs)));
      save();
      applyFs();
      return;
    }
    const chip = target.closest<HTMLElement>("[data-cat]");
    if (chip) {
      document.querySelectorAll(".chip").forEach((el) => el.classList.toggle("on", el === chip));
      filterLib();
    }
  });

  document.getElementById("libQ")?.addEventListener("input", filterLib);

  document.addEventListener("keydown", (event) => {
    const typing = /input|textarea|select/i.test((event.target as HTMLElement)?.tagName ?? "");
    if (typing) return;
    if (event.key.toLowerCase() === "t") {
      state.theme = state.theme === "dark" ? "light" : "dark";
      save();
      applyTheme();
    }
    const prose = document.getElementById("prose");
    if (prose && event.key === "ArrowLeft" && prose.dataset.prev) {
      location.href = prose.dataset.prev;
    }
    if (prose && event.key === "ArrowRight" && prose.dataset.next) {
      location.href = prose.dataset.next;
    }
  });

  window.addEventListener(
    "scroll",
    () => {
      document.getElementById("topbar")?.classList.toggle("scrolled", window.scrollY > 8);
    },
    { passive: true },
  );
}

applyTheme();
applyFs();
hydrateProgress();
bindReveal();
bindReader();
bindPalette();
bindChrome();
