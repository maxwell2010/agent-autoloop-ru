// Failure modes: a real CLI never finishes; a receipt is unreadable; the answer loses the session; cleanup leaves a child
// process or a test database. Claude is pinned to Haiku and all launches, including repair, share a three-turn ceiling.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const use = process.argv[2];
assert.ok(["codex", "claude"].includes(use), "Использование:node scripts/real-agents.ts codex|claude");
const home = mkdtempSync(join(tmpdir(), `agent-autoloop-real-${use}-`));
process.env.AGENT_AUTOLOOP_HOME = home;
process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
mkdirSync(join(home, "work"));
writeFileSync(
  process.env.AGENT_AUTOLOOP_RULES,
  JSON.stringify({
    sources: { app: { name: "Пробный запуск" } },
    agents: {
      real: {
        name: use,
        worker: "test",
        use,
        access: "read",
        timeout: 3,
        ...(use === "claude" ? { model: "claude-haiku-5-5" } : { model: "gpt-6.1-sol", effort: "low" }),
      },
    },
    channels: {},
    rules: [
      {
        name: "Пробный запуск",
        when: { source: "app", types: ["test"] },
        to: "real",
        cwd: join(home, "work"),
        prompt:
          'Это ограниченный тест подключения: прочитайте только указанный файл данных, других действий не выполняйте.answers пусто, в первой строке пишется только «задал вопрос», добавляется agent-autoloop Кодовый блок {"ask":[{"title":"Выберите цвет","text":"Пробный запуск","options":["Синий","Зеленый"],"key":"color"}]}. answers Когда оно не пустое, в последнем сообщении пишется только «Вы выбрали зеленый цвет и пробный запуск пройден», и больше никаких вопросов не задается.',
      },
    ],
  }),
);
const { adapterFor } = await import("../worker/agents.ts");
const adapter = await adapterFor(use);
const launch = adapter.command;
let launches = 0;
adapter.command = (turn) => {
  assert.ok(++launches <= 3, "Три цикла квоты были израсходованы.");
  return launch(turn);
};
const hub = await import("../host/runtime.ts");
const { serve } = await import("../host/http.ts");
const { hubClient } = await import("../protocol/client.ts");
const { createWorker } = await import("../worker/worker.ts");
const server = serve(0);
await new Promise((resolve) => server.once("listening", resolve));
const url = `http://127.0.0.1:${(server.address() as any).port}`;
const owner = hubClient(url, hub.addKey("owner", "me"));
const source = hubClient(url, hub.addKey("source", "app"));
const worker = createWorker({ hub: hubClient(url, hub.addKey("worker", "test")), name: "test", wait: 0, capacity: 1 });
const started = Date.now();
async function until(predicate: (s: any) => boolean) {
  while (Date.now() - started < 240000) {
    await worker.tick();
    const state = await owner.state();
    const failed = state.runs.find((r: any) => r.state === "failed" || r.error);
    if (failed) throw new Error(failed.error ?? JSON.stringify(failed));
    if (predicate(state)) return state;
    await delay(200);
  }
  throw new Error("Реальный пробный запуск превысил четыре минуты");
}
try {
  const problem = adapter.check?.();
  if (problem) throw new Error(problem);
  await source.event({ id: "real", type: "test" });
  const waiting = await until((s) => s.cards.some((c: any) => c.kind === "ask"));
  await owner.answer(waiting.cards[0].id, { choice: 1 });
  const finished = await until((s) =>
    s.runs.some((r: any) => r.state === "done" && r.summary === "Вы выбрали зеленый цвет и прошли пробный запуск."),
  );
  const runs = finished.runs;
  assert.equal(runs.length, 2);
  assert.equal(runs[0].session, runs[1].session);
  assert.ok(runs[0].session);
  console.log(
    JSON.stringify(
      {
        machine: cpus()[0].model,
        node: process.version,
        agent: use,
        model: use === "claude" ? "claude-haiku-5-5" : "gpt-6.1-sol",
        launches,
        runs: runs.length,
        resumed: true,
        ms: Date.now() - started,
        usage: runs.map((r: any) => r.usage),
      },
      null,
      2,
    ),
  );
} finally {
  for (const entry of worker.entries())
    if (entry.pid) {
      try {
        process.kill(-entry.pid, "SIGKILL");
      } catch {}
    }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  hub.db.close();
  rmSync(home, { recursive: true, force: true });
}
