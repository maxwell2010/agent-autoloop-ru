// What the owner stopped stays stopped, and what comes back to a thread comes back to that thread. Failure cases: a run told
// to stop hands in a failure and is queued again, so it starts again minutes later; the card saying it will try again stays
// open once it's stopped, and needs clearing by hand; after a rule stops running in parallel, an answer or a due check starts a
// run on another thread, whose context has neither the answer nor the check, so the question is never really answered.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, evolve, rows, type Fact } from "../kernel/evolve.ts";
import { parseRules } from "../protocol/rules.ts";
import { invariants } from "../sim/invariants.ts";

const env = { secret: "stops", publicUrl: "https://hub.test" };
const rules = parseRules(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"), 0, "UTC");
const MINUTE = 60_000;

function hub() {
  let view = empty();
  let now = Date.UTC(2026, 10, 5, 0, 0, 0);
  const log: Fact[] = [];
  const act = (type: string, ...args: any[]) => {
    const decided = decide(view, { type, args }, now++, env);
    log.push(...decided.facts);
    view = evolve(view, decided.facts);
    return decided.value;
  };
  act("rules", rules);
  return {
    act,
    run: (id: number) => view.get("runs", id)!,
    cards: () => rows(view, "cards"),
    pass: (minutes: number) => void (now += minutes * MINUTE),
    check: () => invariants(view, log),
  };
}

const feedback = { id: "e1", type: "feedback.new", subject: "#1" };
const notParallel = () => {
  const next = structuredClone(rules);
  for (const rule of next.rules) delete rule.parallel;
  return next;
};

/** Fails a run three times, so it's told the owner it will try again, and leaves it queued for the fourth. */
function failedThreeTimes(it: ReturnType<typeof hub>) {
  it.act("ingest", "app", feedback);
  let id = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    it.pass(61);
    const job = it.act("claimNext", "w1", `claim-${attempt}`);
    id = job.run;
    it.act("finish", job.run, job.token, { outcome: "failed", error: "boom" });
  }
  return id;
}
const failing = (it: ReturnType<typeof hub>, id: number) => it.cards().find((card) => card.key === `run:${id}:failing`);

test("a run told to stop that hands in a failure stays stopped, and doesn't start again", () => {
  const it = hub();
  it.act("ingest", "app", feedback);
  const job = it.act("claimNext", "w1", "c1");
  it.act("cancel", job.run);
  it.act("finish", job.run, job.token, { outcome: "failed", error: "boom" });
  assert.equal(it.run(job.run).state, "cancelled");
  assert.equal(it.run(job.run).finished_at !== null, true);
  it.pass(120);
  assert.equal(it.act("claimNext", "w1", "c2"), null);
  it.check();
});

test("a failure handed in with no stop asked for still tries again", () => {
  const it = hub();
  it.act("ingest", "app", feedback);
  const job = it.act("claimNext", "w1", "c1");
  it.act("finish", job.run, job.token, { outcome: "failed", error: "boom" });
  assert.equal(it.run(job.run).state, "queued");
  it.check();
});

test("stopping a run waiting to try again closes the card that says it will", () => {
  const it = hub();
  const id = failedThreeTimes(it);
  assert.equal(failing(it, id)?.state, "open");
  it.act("cancel", id);
  assert.equal(it.run(id).state, "cancelled");
  assert.equal(failing(it, id)?.state, "closed");
  it.check();
});

test("a run with that card, stopped while it's going, closes the card when it has stopped", () => {
  const it = hub();
  const id = failedThreeTimes(it);
  it.pass(61);
  const job = it.act("claimNext", "w1", "last");
  assert.equal(job.run, id);
  it.act("cancel", id);
  assert.equal(failing(it, id)?.state, "open", "not stopped yet");
  it.act("finish", job.run, job.token, { outcome: "cancelled", summary: "Остановлено" });
  assert.equal(failing(it, id)?.state, "closed");
  it.check();
});

test("a run told to stop whose worker stopped mentioning it closes the card that says it may still be going", () => {
  const it = hub();
  it.act("ingest", "app", feedback);
  const job = it.act("claimNext", "w1", "c1");
  it.act("cancel", job.run);
  it.pass(6);
  it.act("heartbeat", "w1", []);
  it.act("tick");
  assert.equal(it.run(job.run).state, "unknown");
  const unknown = () => it.cards().find((card) => card.key === `run:${job.run}:unknown`);
  assert.equal(unknown()?.state, "open");
  it.act("finish", job.run, job.token, { outcome: "failed", error: "boom" });
  assert.equal(it.run(job.run).state, "cancelled");
  assert.equal(unknown()?.state, "closed");
  it.check();
});

test("an answer comes back to the thread that asked, after the rule stopped running in parallel", () => {
  const it = hub();
  it.act("ingest", "app", feedback);
  const job = it.act("claimNext", "w1", "c1");
  const question = { title: "选哪", text: "选Один", options: ["А", "Б"], about: "接着делать" };
  it.act("finish", job.run, job.token, { outcome: "done", summary: "问了", session: "S", ask: [question] });
  const [card] = it.cards().filter((card) => card.kind === "ask");
  assert.equal(card.lane, "#1", "the fixture's rule runs in parallel");
  it.act("rules", notParallel());
  it.act("answer", card.id, { choice: 1 });
  const next = it.act("claimNext", "w1", "c2");
  assert.equal(it.run(next.run).lane, "#1");
  assert.equal(next.session, "S");
  assert.deepEqual(
    next.context.answers.map((answer: any) => answer.choice),
    [1],
  );
  it.act("finish", next.run, next.token, { outcome: "done", summary: "Закончено" });
  it.check();
});

test("a due check comes back to its thread, after the rule stopped running in parallel", () => {
  const it = hub();
  it.act("ingest", "app", feedback);
  const job = it.act("claimNext", "w1", "c1");
  const later = { key: "看看", at: "2026-11-05T01:00:00Z", about: "Проверьте, когда придет время" };
  it.act("finish", job.run, job.token, { outcome: "done", summary: "约了", session: "S", later: [later] });
  it.act("rules", notParallel());
  it.pass(61);
  it.act("tick");
  const next = it.act("claimNext", "w1", "c2");
  assert.equal(it.run(next.run).lane, "#1");
  assert.deepEqual(
    next.context.timers.map((timer: any) => timer.key),
    ["看看"],
  );
  it.act("finish", next.run, next.token, { outcome: "done", summary: "查过了" });
  it.check();
});
