// Failure modes: explain prints a rule's private prompt; a dry run writes to the hub instead of previewing; the
// preview ignores another rule for the same event; a bad subcommand is accepted silently; a dry run with another source's key
// previews this machine's source instead.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { explainRules, previewEvent } from "../cli/explain.ts";
import { InputError } from "../kernel/errors.ts";
import { at, setup } from "./helpers.ts";

const fixture = readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8");
const home = setup("rules-preview");
const cli = async (...args: string[]) =>
  (
    await promisify(execFile)(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "../bin/agent-autoloop.ts"), ...args],
      { env: { ...process.env } },
    )
  ).stdout;

test("explain lists rules, agents, channels and next runs, but no prompt or skill text", () => {
  const lines = explainRules(fixture, at(0), "UTC").join("\n");
  for (const words of [
    "Мнение",
    "feedback.*",
    "a1",
    "права edit",
    "chat",
    "Ответчик me",
    "каждый день 09:00",
    "В следующий раз",
    "Осмотр",
  ])
    assert.ok(lines.includes(words), words + "\n" + lines);
  for (const privateText of [
    "Следуйте руководству.",
    "Обработка сигналов тревоги.",
    "记下来. ",
    "Напишите утреннюю газету.",
  ])
    assert.ok(!lines.includes(privateText), privateText);
});

test("explain says which rules go on in the last round's session", () => {
  assert.ok(!explainRules(fixture, at(0), "UTC").join("\n").includes("продолжить сессию прошлого цикла"));
  const given = JSON.parse(fixture);
  given.rules[0].resume = true;
  const lines = explainRules(JSON.stringify(given), at(0), "UTC");
  assert.ok(
    lines.some((line) => line.includes("feedback.*") && line.includes("продолжить сессию прошлого цикла")),
    lines.join("\n"),
  );
});

test("a dry run says which rules would take the event, and doesn't need a hub", () => {
  assert.match(
    previewEvent(fixture, "app", { id: "1", type: "feedback.new", subject: "#1" }, at(0), "UTC").join("\n"),
    /Мнение → a1/,
  );
  const alerts = previewEvent(fixture, "ops", { id: "2", type: "alert.raised" }, at(0), "UTC").join("\n");
  assert.ok(alerts.includes("Тревога → a2") && alerts.includes("Тревога также записывается. → a1"), alerts);
  assert.match(
    previewEvent(fixture, "app", { id: "3", type: "else.new" }, at(0), "UTC").join("\n"),
    /Для события нет правила/,
  );
  assert.throws(() => previewEvent(fixture, "app", { id: "4", type: "not a type" }, at(0), "UTC"), InputError);
});

test("the commands read the local rules file and refuse an unknown subcommand", async () => {
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ url: "http://127.0.0.1:1", source: { name: "app", key: "test-only" } }),
  );
  assert.match(await cli("rules", "explain"), /Мнение/);
  const preview = await cli("emit", "feedback.new", "--dry-run", "--subject", "#1");
  assert.match(preview, /Предварительный просмотр/);
  assert.match(preview, /Мнение → a1/);
  await assert.rejects(cli("rules", "nope"), /Использование/);
  await assert.rejects(cli("emit", "feedback.new", "--dry-run", "--key", "another-source"), /--key/);
});
