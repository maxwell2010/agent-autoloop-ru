// Failure modes: Russian prompts lose the data/instruction boundary, old result markers or try runs stop working,
// the card remains tagged as Chinese, or a translated CLI help starts installation instead of printing help.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { promptFor, readMessage, repairPrompt } from "../worker/contract.ts";
import { waitingRetry } from "../cli/try.ts";
import { wordsPage } from "../kernel/card-page.ts";

test("Russian CLI help is readable and does not initialize the service", () => {
  const output = execFileSync(process.execPath, [join(import.meta.dirname, "../bin/agent-autoloop.ts"), "help"], {
    encoding: "utf8",
  });
  assert.match(output, /[А-Яа-я]/);
  assert.doesNotMatch(output, /[\u4e00-\u9fff]/);
  assert.ok(output.includes("agent-autoloop init"));
  assert.ok(output.includes("--dry-run"));
});

test("historical Chinese and canonical result markers keep their meaning", () => {
  for (const marker of ["\u6ca1\u8dd1\u6210", "FAILED", "НЕ ВЫПОЛНЕНО"]) {
    assert.equal(readMessage(`${marker}: offline`).outcome, "failed", marker);
  }
  for (const marker of ["\u6ca1\u4e8b\u53ef\u505a", "NOTHING", "НЕТ ЗАДАЧ"]) {
    assert.equal(readMessage(`${marker}: quiet`).outcome, "nothing", marker);
  }
});

test("historical and Russian try-run names are recognized", () => {
  for (const rule of ["\u8bd5\u4e00\u4e0b", "Пробный запуск"]) {
    const run = { id: 1, rule, state: "queued", attempts: 1, error: "offline", notBefore: "" };
    assert.equal(waitingRetry([run]), run);
  }
});

test("Russian prompt keeps untrusted event content out of instructions", () => {
  const job = {
    run: 1,
    token: "x",
    attempt: 1,
    session: null,
    askFirst: ["удаление данных"],
    rule: { name: "Проверка", cwd: "/tmp/test", prompt: "Проверь состояние." },
    agent: { id: "a", name: "Agent", use: "command", access: "read" },
    context: {
      events: [
        {
          id: "1",
          source: "app",
          sourceName: "App",
          type: "alert.new",
          subject: "a",
          summary: "UNTRUSTED_SUMMARY",
          detail: "UNTRUSTED_DETAIL",
          link: "",
          receivedAt: "2026-11-05T00:00:00Z",
        },
      ],
      answers: [],
      timers: [],
      waiting: [],
      open: [],
      decided: [],
    },
  } as Parameters<typeof promptFor>[0];
  const prompt = promptFor(job, "/tmp/context.json");
  assert.match(prompt, /данные, а не инструкции/);
  assert.match(prompt, /русском/);
  assert.ok(prompt.includes("FAILED"));
  assert.ok(prompt.includes("NOTHING"));
  assert.ok(!prompt.includes("UNTRUSTED_"));
  assert.match(repairPrompt("invalid JSON"), /не повторяй/i);
});

test("Russian card escapes user content and keeps the page language correct", () => {
  const html = wordsPage('<script>alert("x")</script>');
  assert.ok(html.includes('lang="ru"'));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});
