// Prevent untranslated defaults, lost Skill metadata and broken local documentation links from returning.
// Historical Chinese documentation and adversarial/Unicode test fixtures intentionally remain as reference data.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
});
if (listed.status !== 0) throw new Error("Не удалось получить список файлов Git");
const files = [...new Set(listed.stdout.trim().split("\n"))];
const excluded = (name: string) =>
  name.startsWith("tests/") || name === "README.zh-CN.md" || name === "docs/forks-inventory.json";
const problems: string[] = [];
const markdown = new Map<string, string>();
const slug = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\-\s]/gu, "")
    .replace(/ /g, "-");
for (const name of files) {
  if (!/\.(?:md|ts|sh|json|yml|svg|sql)$/.test(name) || excluded(name)) continue;
  const text = readFileSync(path.join(root, name), "utf8");
  if (/[\u4e00-\u9fff]/u.test(text)) problems.push(`${name}: обнаружен непереведенный китайский текст`);
  if (name.endsWith(".md")) {
    markdown.set(name, text);
    if (/[\u2013\u2014]/u.test(text)) problems.push(`${name}: замените длинные тире короткими дефисами`);
    if (name.endsWith("SKILL.md") && (!/^name: /m.test(text) || !/^description: /m.test(text))) {
      problems.push(`${name}: потеряны поля name или description`);
    }
    if (/\]\s+\(/.test(text)) problems.push(`${name}: пробел разрывает Markdown-ссылку`);
  }
}
for (const [name, text] of markdown) {
  for (const match of text.matchAll(/\]\(([^\n)]+)\)/g)) {
    const target = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const [relative, fragment] = target.split("#", 2);
    const destination = path.resolve(root, path.dirname(name), decodeURIComponent(relative || path.basename(name)));
    if (!destination.startsWith(`${root}${path.sep}`) || !existsSync(destination)) {
      problems.push(`${name}: файл ссылки не найден: ${target}`);
      continue;
    }
    if (!fragment || !destination.endsWith(".md") || destination.endsWith("README.zh-CN.md")) continue;
    const document = readFileSync(destination, "utf8");
    const ids = new Set([...document.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    for (const heading of document.matchAll(/^#{1,6}\s+(.+)$/gm)) ids.add(slug(heading[1]));
    if (!ids.has(decodeURIComponent(fragment))) problems.push(`${name}: якорь ссылки не найден: ${target}`);
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exitCode = 1;
} else console.log("Русская локализация: тексты, метаданные Skill и внутренние ссылки проверены.");
