#!/usr/bin/env node
/**
 * 把一套已有的 Markdown 拷进 content/<项目>/。
 * 文件名用数字开头即可，例如 00-intro.md。封面是同目录 _book.md。
 *
 *   node scripts/import-series.mjs --book pi --from ../page-collection/notes/pi
 */
import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? "" : process.argv[index + 1] ?? "";
}

const book = arg("book");
const from = arg("from");
if (!book || !from) {
  console.error("usage: node scripts/import-series.mjs --book <id> --from <dir>");
  process.exit(1);
}

const sourceDir = resolve(process.cwd(), from);
const destDir = join(root, "content", book);
const files = (await readdir(sourceDir)).filter((name) => /^\d+.*\.md$/i.test(name));

if (!files.length) {
  console.error(`no numbered markdown files in ${sourceDir}`);
  process.exit(1);
}

await mkdir(destDir, { recursive: true });
for (const file of files) {
  await cp(join(sourceDir, file), join(destDir, file));
}

console.log(`copied ${files.length} articles → content/${book}/`);
console.log(`cover file: content/${book}/_book.md （没有的话请手写一篇）`);
