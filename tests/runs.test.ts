// Work goes to the worker of the rule's agent, one run at a time in each group, or for a rule that runs in parallel one
// run at a time for each subject and no more than its number at once in the group, and comes back with what happened.
// Failure cases: a worker takes work for another worker's agent, or the same work twice; a lost answer to a claim loses the
// work (the same claim must get it back) or hands it out twice; events arriving while work waits make more runs instead of
// joining it; work in a group starts while another in it is still running; a parallel rule puts two subjects in one run,
// starts a second run on a subject while one runs, or more runs at once than its number; a finished run leaves the next one
// waiting; a failed run is lost, retried at once, not merged with what came in meanwhile for it, or merged with another
// subject's; the owner is told of every run instead of what the rule says, not told of a third failure in a row, told of it
// twice, or not told when a worker stops reporting work it took or stops coming; a run token works for another run, or a
// stale one is accepted after the run was handed out again; a replayed result isn't recognised, or a different one under an
// old token is taken; a failed run's receipt takes effect (it will run again) beyond what it tells the owner; a worker
// gone with work in hand frees its group while the work may still be going; cancelling frees the thread before the worker
// has stopped; a retry doesn't get its own session back; retries overwrite usage or replayed results count it twice; a run
// that keeps failing goes on spending for good, stops without telling the owner, or takes newer events down with it.
// A report of starting is taken whatever it holds, however long; stopping a run that isn't there or has ended crashes,
// or marks it as stopping.
// Reloading rules must not combine an old agent with a new folder, or change an already claimed job and its worker.
import assert from "node:assert/strict";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";

setup("runs");
const { ingest } = await import("../host/runtime.ts");
const { claimNext, heartbeat, finish, started, sweep, cancel, cancels } = await import("../host/runtime.ts");
const { AuthError, Conflict, InputError, NotFound } = await import("../kernel/errors.ts");
const { all, one, run } = await import("./storage.ts");

const note = (n: number, step = "new") => ({
  id: `feedback:${n}:${step}`,
  type: `feedback.${step}`,
  subject: `#${n}`,
  summary: `номер ${n} 条`,
  link: `https://x.test/feedback?id=${n}`,
});
const alert = (key: string) => ({ id: `alert:${key}`, type: "alert.raised", subject: key });
const told = () =>
  all<{ key: string; title: string; text: string; state: string }>(
    "SELECT key, title, text, state FROM cards ORDER BY id",
  );
const clean = () => {
  for (const table of ["run_events", "runs", "events", "seen", "cards", "deliveries", "timers"])
    run(`DELETE FROM ${table}`);
};
const claim = (worker: string, now: number) => claimNext(worker, `c${Math.random()}`, now);
const state = (id: number) => one<{ state: string }>("SELECT state FROM runs WHERE id = ?", [id])!.state;

test("usage accumulates across attempts once, without inventing unreported fields", () => {
  clean();
  ingest("app", note(1), at(0));
  const first = claim("w1", at(0))!;
  const failed = { outcome: "failed", usage: { input: 1000, output: 100, cost: 1 } };
  finish(first.run, first.token, failed, at(1));
  finish(first.run, first.token, failed, at(2));
  const retry = claim("w1", at(6))!;
  const done = { outcome: "done", usage: { input: 200, output: 20, cost: 0.2 } };
  finish(retry.run, retry.token, done, at(7));
  finish(retry.run, retry.token, done, at(8));
  const usage = JSON.parse(one<{ usage: string }>("SELECT usage FROM runs WHERE id = ?", [first.run])!.usage);
  assert.deepEqual(usage, { input: 1200, output: 120, cost: 1.2 });
});

test("work goes only to its agent's worker, once, with the rule and what to read", () => {
  clean();
  ingest("ops", alert("probe.public"), at(0));
  const w2 = claim("w2", at(1))!;
  assert.equal(w2.rule.name, "Тревога");
  assert.equal(w2.agent.use, "codex");
  assert.equal(w2.agent.access, "full");
  assert.deepEqual(
    w2.context.events.map((e) => [e.sourceName, e.type, e.subject]),
    [["运维", "alert.raised", "probe.public"]],
  );
  assert.ok(w2.askFirst.includes("Удаление данных"));
  assert.equal(claim("w2", at(1)), null);
  const w1 = claim("w1", at(1))!;
  assert.equal(w1.rule.name, "Тревога также записывается.");
  assert.equal(w1.agent.access, "edit");
  assert.equal(claim("w1", at(1)), null);
  assert.equal(claim("nobody", at(1)), null);
});

test("queued work takes the current agent and folder together; a held claim keeps its configuration", async () => {
  clean();
  const hub = await import("../host/runtime.ts");
  const before = hub.getView().get("config", "rules")!.value;
  const next = structuredClone(before);
  next.rules[0].to = "a2";
  next.rules[0].cwd = "/new-project";
  ingest("app", note(1), at(0));
  try {
    hub.execute("rules", [next], at(1));
    assert.equal(claim("w1", at(2)), null, "the previous worker must not take the new configuration");
    const first = claimNext("w2", "reloaded", at(2))!;
    assert.ok(first);
    assert.equal(first.agent.id, "a2");
    assert.equal(first.rule.cwd, "/new-project");
    const later = structuredClone(next);
    later.rules[0].cwd = "/another-project";
    later.agents.a2.worker = "w3";
    later.agents.a2.access = "read";
    hub.execute("rules", [later], at(3));
    const again = claimNext("w2", "reloaded", at(4))!;
    assert.ok(again, "a lost claim response still belongs to its original worker");
    assert.deepEqual({ ...again, token: first.token }, first);
    heartbeat("w2", [first.run], at(5));
    assert.equal(hub.getView().get("runs", first.run)!.seen_at, new Date(at(5)).toISOString());
    cancel(first.run, at(6));
    assert.deepEqual(cancels("w2"), [first.run]);
    assert.deepEqual(cancels("w3"), []);
  } finally {
    hub.execute("rules", [before], at(7));
  }
});

test("a claim whose answer was lost gets the same work back, under a token that works", () => {
  clean();
  ingest("ops", alert("x"), at(0));
  const first = claimNext("w2", "claim-1", at(1))!;
  const again = claimNext("w2", "claim-1", at(2))!;
  assert.equal(again.run, first.run);
  assert.equal(again.attempt, first.attempt);
  assert.throws(
    () => finish(first.run, first.token, { outcome: "done" }, at(3)),
    AuthError,
    "the answer that was lost holds nothing",
  );
  finish(again.run, again.token, { outcome: "done", summary: "Хорошо" }, at(3));
  assert.equal(claimNext("w2", "claim-1", at(4)), null, "a claim that finished doesn't come back");
  // Another worker's claim id doesn't reach it.
  ingest("ops", alert("y"), at(5));
  const third = claimNext("w2", "claim-2", at(5))!;
  assert.equal(claimNext("w1", "claim-2", at(6))?.run === third.run, false);
});

test("events while work waits join it; while it runs they wait for the next run", () => {
  clean();
  ingest("ops", alert("first"), at(0));
  ingest("ops", alert("second"), at(1));
  const first = claim("w2", at(2))!;
  assert.deepEqual(
    first.context.events.map((e) => e.subject),
    ["first", "second"],
  );
  ingest("ops", alert("third"), at(3));
  assert.equal(claim("w2", at(4)), null, "the group already has a run going");
  finish(first.run, first.token, { outcome: "done", summary: "Были обработаны два сигнала тревоги." }, at(5));
  const second = claim("w2", at(5))!;
  assert.deepEqual(
    second.context.events.map((e) => e.subject),
    ["third"],
  );
});

test("a parallel rule runs each subject on its own, no more than its number at once", () => {
  clean();
  for (const n of [1, 2, 3, 4]) ingest("app", note(n), at(n));
  const running = [1, 2, 3].map(() => claim("w1", at(5))!);
  assert.deepEqual(
    running.map((job) => job.context.events.map((e) => e.subject)),
    [["#1"], ["#2"], ["#3"]],
  );
  assert.equal(claim("w1", at(5)), null, "three at once at most");
  finish(running[1].run, running[1].token, { outcome: "done", summary: "номер 2 条Исправлено" }, at(6));
  assert.deepEqual(
    claim("w1", at(6))!.context.events.map((e) => e.subject),
    ["#4"],
  );
});

test("a subject's events join its waiting run, and wait while it runs; other subjects go on", () => {
  clean();
  ingest("app", note(1), at(0));
  ingest("app", note(1, "followup"), at(1));
  ingest("app", note(2), at(2));
  const first = claim("w1", at(3))!;
  assert.deepEqual(
    first.context.events.map((e) => [e.type, e.subject]),
    [
      ["feedback.new", "#1"],
      ["feedback.followup", "#1"],
    ],
  );
  assert.deepEqual(
    claim("w1", at(3))!.context.events.map((e) => e.subject),
    ["#2"],
  );
  ingest("app", note(1, "decided"), at(4));
  assert.equal(claim("w1", at(4)), null, "#1 already has a run going");
  finish(first.run, first.token, { outcome: "done", summary: "номер 1 条Хорошо" }, at(5));
  assert.deepEqual(
    claim("w1", at(5))!.context.events.map((e) => [e.type, e.subject]),
    [["feedback.decided", "#1"]],
  );
});

test("a failed run comes back later with what came in meanwhile, in its own session, and the third failure in a row is told once", () => {
  clean();
  ingest("app", note(1), at(0));
  let job = claim("w1", at(0))!;
  assert.equal(job.session, null);
  started(job.run, job.token, { session: "s-1", link: "app://s-1" }, at(0));
  ingest("app", note(1, "followup"), at(1));
  ingest("app", note(2), at(1));
  const other = claim("w1", at(1))!;
  assert.deepEqual(
    other.context.events.map((e) => e.subject),
    ["#2"],
  );
  finish(job.run, job.token, { outcome: "failed", error: "没Загрузка出Инструменты" }, at(2));
  assert.equal(claim("w1", at(6)), null, "the first retry waits five minutes");
  job = claim("w1", at(7))!;
  assert.equal(job.attempt, 2);
  assert.equal(job.session, "s-1");
  assert.deepEqual(
    job.context.events.map((e) => [e.type, e.subject]),
    [
      ["feedback.new", "#1"],
      ["feedback.followup", "#1"],
    ],
  );
  assert.deepEqual(
    all<{ id: number }>("SELECT id FROM runs WHERE rule = 'Мнение' ORDER BY id").map((r) => r.id),
    [job.run, other.run],
  );
  finish(job.run, job.token, { outcome: "failed", error: "没Загрузка出Инструменты" }, at(8));
  assert.equal(claim("w1", at(17)), null, "the second waits ten");
  job = claim("w1", at(18))!;
  assert.deepEqual(told(), []);
  finish(job.run, job.token, { outcome: "failed", error: "没Загрузка出Инструменты" }, at(19));
  assert.equal(told().length, 1);
  assert.match(
    told()[0].text,
    /подряд 3 попыток не завершены \(этап:没Загрузка出Инструменты\), 10:39 Автоматически повторит попытку/,
  );
  job = claim("w1", at(39))!;
  finish(job.run, job.token, { outcome: "failed", error: "还是不行" }, at(40));
  assert.equal(told().length, 1);
  assert.equal(claim("w1", at(79)), null, "and so on, doubling");
  job = claim("w1", at(80))!;
  finish(job.run, job.token, { outcome: "done", summary: "Хорошо" }, at(81));
  assert.equal(told()[0].state, "closed", "once it has worked the failing card closes by itself");
});

test("after ten failures in a row a run stops, tells the owner once, and newer events still get done", () => {
  clean();
  ingest("app", note(1), at(0));
  const step = 100;
  let job = claim("w1", at(0))!;
  const { run: id } = job;
  for (let failure = 1; failure < 10; failure++) {
    finish(id, job.token, { outcome: "failed", error: "没登录" }, at(failure * step));
    assert.equal(state(id), "queued", `still retrying after failure ${failure}`);
    job = claim("w1", at((failure + 1) * step - 1))!;
    assert.equal(job.run, id);
  }
  ingest("app", note(1, "followup"), at(10 * step - 2));
  finish(id, job.token, { outcome: "failed", error: "没登录. " }, at(10 * step));
  assert.equal(state(id), "cancelled");
  const stopped = one<{ attempts: number; error: string; summary: string; finished_at: string }>(
    "SELECT attempts, error, summary, finished_at FROM runs WHERE id = ?",
    [id],
  )!;
  assert.equal(stopped.attempts, 10);
  assert.equal(stopped.error, "没登录");
  assert.match(stopped.summary, /подряд 10 неудач; автоматические повторы прекращены/);
  assert.ok(stopped.finished_at);
  const open = told().filter((card) => card.state === "open");
  assert.deepEqual(
    open.map((card) => card.key),
    [`run:${id}:stopped`],
    "the third-failure card has been replaced by this one",
  );
  assert.match(
    open[0].text,
    /подряд 10 попыток не завершены.*этап:没登录.*Больше никаких автоматических повторных попыток/,
  );

  const next = claim("w1", at(10 * step + 1))!;
  assert.notEqual(next.run, id, "what came in meanwhile is its own run, with a clean count");
  assert.equal(next.attempt, 1);
  assert.deepEqual(
    next.context.events.map((event) => event.type),
    ["feedback.followup"],
  );
  finish(next.run, next.token, { outcome: "done", summary: "Хорошо" }, at(10 * step + 2));
  assert.equal(claim("w1", at(100 * step)), null, "nothing is left to run again by itself");
});

test("the owner is told what the rule says: needed only with a card, always every time, never only what blocks work", () => {
  clean();
  ingest("app", note(1), at(0));
  let job = claim("w1", at(0))!;
  finish(job.run, job.token, { outcome: "done", summary: "номер 1 条Исправлено" }, at(1));
  assert.deepEqual(told(), []);
  ingest("app", note(2), at(2));
  job = claim("w1", at(2))!;
  finish(
    job.run,
    job.token,
    {
      outcome: "done",
      summary: "Код доступен онлайн.",
      notice: [{ title: "требуетсяОткрытый авторитет", text: "требуетсятыделать:开通读抖音数据для权限. " }],
    },
    at(3),
  );
  assert.deepEqual(
    told().map((m) => [m.title, m.text, m.state]),
    [["требуетсяОткрытый авторитет", "требуетсятыделать:开通读抖音数据для权限. ", "open"]],
  );

  clean();
  ingest("ops", alert("probe.public"), at(0));
  const ops = claim("w2", at(0))!;
  const quiet = claim("w1", at(0))!;
  finish(ops.run, ops.token, { outcome: "done", summary: "网站已恢复" }, at(1));
  finish(
    quiet.run,
    quiet.token,
    { outcome: "done", summary: "记下了", notice: [{ title: "看Один眼", text: "细节" }] },
    at(1),
  );
  const cards = all<{ title: string; text: string; state: string; fyi: number; quiet: number }>(
    "SELECT title, text, state, fyi, quiet FROM cards ORDER BY id",
  );
  assert.deepEqual(
    cards[0],
    { title: "Тревога", text: "网站已恢复", state: "closed", fyi: 1, quiet: 0 },
    "always: told and needs nothing back",
  );
  assert.deepEqual(
    cards[1],
    { title: "看Один眼", text: "细节", state: "open", fyi: 0, quiet: 1 },
    "never: kept for the page, not pushed",
  );
});

test("a run with nothing to do is told to nobody and frees its group", () => {
  clean();
  ingest("ops", alert("probe.public"), at(0));
  const job = claim("w2", at(0))!;
  finish(job.run, job.token, { outcome: "nothing", summary: "Уже восстановлено" }, at(1));
  assert.equal(state(job.run), "nothing");
  assert.deepEqual(told(), []);
  ingest("ops", alert("probe.public:2"), at(2));
  assert.ok(claim("w2", at(2)));
});

test("a result is checked strictly and nothing of a bad one takes effect", () => {
  clean();
  ingest("ops", alert("x"), at(0));
  const job = claim("w2", at(0))!;
  for (const bad of [
    null,
    [],
    {},
    { outcome: "maybe" },
    { outcome: "done", oops: 1 },
    { outcome: "done", summary: "x".repeat(501) },
    { outcome: "failed", error: "x".repeat(501) },
    { outcome: "done", ask: [{ title: "x", text: "y", options: ["Существует только один"] }] },
    { outcome: "done", ask: [{ title: "x", text: "y", options: ["a", "b", "c", "d", "e", "f"] }] },
    { outcome: "done", ask: [{ title: "x", text: "y", options: ["a", "b"], recommend: 2 }] },
    { outcome: "done", ask: [{ title: "", text: "y", options: ["a", "b"] }] },
    { outcome: "done", notice: [{ title: "x".repeat(201), text: "y" }] },
    { outcome: "done", resolve: [{ card: 1.5, reason: "x" }] },
    { outcome: "done", resolve: [{ card: 1, reason: " " }] },
    { outcome: "done", later: [{ key: "x", at: "not a time", about: "y" }] },
    { outcome: "done", later: [{ key: "x", at: "2026-10-18T10:00:00", about: "y" }] },
    { outcome: "done", later: [{ key: "x", cancel: false }] },
    { outcome: "done", usage: { input: "many" } },
  ])
    assert.throws(() => finish(job.run, job.token, bad, at(1)), InputError, JSON.stringify(bad));
  assert.equal(state(job.run), "claimed");
  assert.deepEqual(told(), []);
});

test("a failed run's receipt tells the owner but changes nothing else: it will run again", () => {
  clean();
  ingest("app", note(1), at(0));
  let job = claim("w1", at(0))!;
  const seen = job.run;
  const receipt = finish(
    job.run,
    job.token,
    {
      outcome: "failed",
      error: "требуется批准",
      notice: [{ title: "требуетсяты批准", text: "确认服务器权限" }],
      ask: [{ title: "x", text: "y", options: ["a", "b"] }],
      later: [{ key: "k", at: "2026-10-18T10:00:00+08:00", about: "y" }],
      events: [{ id: "e", type: "feedback.new" }],
    },
    at(1),
  );
  assert.deepEqual(
    told().map((m) => m.title),
    ["требуетсяты批准"],
  );
  assert.equal(all("SELECT id FROM timers").length, 0);
  assert.equal(all("SELECT id FROM events").length, 1);
  assert.deepEqual(
    receipt.rejected.map((r) => r.reason),
    [
      "Неудачный цикл может отправлять только уведомления",
      "Неудачный цикл может отправлять только уведомления",
      "Неудачный цикл может отправлять только уведомления",
    ],
  );
  // The same notice when it fails again isn't told again; a new one is. And a failure with its own notice isn't also told as a failure.
  for (const n of [1, 2]) {
    job = claim("w1", at(70 * n))!;
    assert.equal(job.run, seen);
    finish(
      job.run,
      job.token,
      {
        outcome: "failed",
        error: "требуется批准",
        notice: [
          { title: "требуетсяты批准", text: "确认服务器权限" },
          ...(n === 2 ? [{ title: "还требуется", text: "插上手机" }] : []),
        ],
      },
      at(70 * n),
    );
  }
  assert.deepEqual(
    told().map((m) => m.title),
    ["требуетсяты批准", "还требуется"],
  );
});

test("a run token works only for its run, and only for that attempt; a replay gets the same answer", () => {
  clean();
  ingest("app", note(1), at(0));
  ingest("ops", alert("x"), at(0));
  const mine = claim("w1", at(0))!;
  const theirs = claim("w2", at(0))!;
  assert.throws(() => finish(mine.run, theirs.token, { outcome: "done", summary: "x" }, at(1)), AuthError);
  assert.throws(() => started(mine.run, "made-up", { link: "app://1" }, at(1)), AuthError);
  started(mine.run, mine.token, { link: "app://1" }, at(1));
  const failure = { outcome: "failed", error: "断网" };
  finish(mine.run, mine.token, failure, at(2));
  assert.equal(
    finish(mine.run, mine.token, failure, at(3)).duplicate,
    true,
    "the answer was lost: the same report is taken as already taken",
  );
  assert.equal(state(mine.run), "queued");
  assert.throws(() => finish(mine.run, mine.token, { outcome: "done", summary: "旧для那次" }, at(3)), Conflict);
  const again = claim("w1", at(8))!;
  assert.equal(again.run, mine.run);
  assert.notEqual(again.token, mine.token);
  assert.throws(
    () => finish(mine.run, mine.token, { outcome: "done", summary: "旧для那次" }, at(9)),
    AuthError,
    "an older attempt's token is gone",
  );
  const success = {
    outcome: "done",
    summary: "Хорошо",
    notice: [{ title: "Одна деталь", text: "Отправлять только один раз" }],
  };
  finish(again.run, again.token, success, at(9));
  assert.equal(finish(again.run, again.token, success, at(10)).duplicate, true);
  assert.throws(() => finish(again.run, again.token, { outcome: "done", summary: "Опять" }, at(10)), Conflict);
  assert.equal(told().filter((m) => m.title === "Одна деталь").length, 1);
});

test("work a worker took and stopped reporting while it keeps coming is told once as unknown; a late result still counts", () => {
  clean();
  const unknown = () => told().filter((m) => m.key.startsWith("run:"));
  ingest("ops", alert("probe.public"), at(0));
  const job = claim("w2", at(0))!;
  heartbeat("w2", [job.run], at(3));
  heartbeat("w2", [], at(6));
  sweep(at(6));
  assert.deepEqual(unknown(), []);
  heartbeat("w2", [], at(9));
  sweep(at(9));
  assert.equal(state(job.run), "unknown");
  assert.equal(unknown().length, 1);
  assert.match(unknown()[0].text, /Исполнитель Б не отвечает более 5 минут/);
  heartbeat("w2", [], at(12));
  sweep(at(12));
  assert.equal(unknown().length, 1);
  ingest("ops", alert("other"), at(13));
  assert.ok(claim("w2", at(13)), "an unknown run no longer holds its group");
  finish(job.run, job.token, { outcome: "done", summary: "Фактически исправлено" }, at(14));
  assert.equal(state(job.run), "done");
  assert.equal(unknown()[0].state, "closed", "the card closes once the result is in");
});

test("a worker gone with work in hand keeps the work, is told once each time it goes away, and the card closes when it's back", () => {
  clean();
  heartbeat("w1", [], at(0));
  ingest("app", note(1), at(1));
  const job = claim("w1", at(1))!;
  heartbeat("w1", [job.run], at(2));
  sweep(at(11));
  assert.deepEqual(told(), []);
  sweep(at(13));
  assert.equal(state(job.run), "claimed", "gone isn't lost: it may still be working");
  assert.deepEqual(
    told().map((m) => m.text),
    [
      "Исполнитель w1 не подключается к сервису 11 мин.; в очереди или в работе: 1. Проверьте питание, спящий режим и сетевое подключение.",
    ],
  );
  sweep(at(30));
  assert.equal(told().length, 1);
  heartbeat("w1", [job.run], at(31));
  sweep(at(31));
  assert.equal(told()[0].state, "closed");
  sweep(at(45));
  assert.equal(told().length, 2, "it went away again, with work in hand");

  clean();
  ingest("ops", alert("first"), at(0));
  sweep(at(11));
  assert.deepEqual(
    told()
      .map((m) => m.text)
      .sort(),
    [
      "Исполнитель w1 еще не подключался к сервису; 1 задач ожидают 11 мин. Проверьте, включен ли компьютер и подключен ли он к сети",
      "Исполнитель w2 еще не подключался к сервису; 1 задач ожидают 11 мин. Проверьте, включен ли компьютер и подключен ли он к сети",
    ],
  );
});

test("cancelling a waiting run ends it; cancelling a running one holds its thread until the worker says it stopped", () => {
  clean();
  ingest("ops", alert("a"), at(0));
  const going = claim("w2", at(0))!;
  ingest("ops", alert("b"), at(1));
  const waiting = one<{ id: number }>("SELECT id FROM runs WHERE state = 'queued' AND agent = 'a2'")!.id;
  cancel(waiting, at(2));
  assert.equal(state(waiting), "cancelled");
  assert.deepEqual(cancels("w2"), []);
  cancel(going.run, at(3));
  assert.equal(state(going.run), "claimed");
  assert.deepEqual(cancels("w2"), [going.run]);
  assert.deepEqual(cancels("w1"), []);
  ingest("ops", alert("c"), at(4));
  assert.equal(claim("w2", at(4)), null, "still holding its group");
  finish(going.run, going.token, { outcome: "cancelled" }, at(5));
  assert.equal(state(going.run), "cancelled");
  assert.deepEqual(cancels("w2"), []);
  assert.ok(claim("w2", at(5)));
});

test("stopping a run that isn't there, or has already ended, is refused and changes nothing", () => {
  clean();
  assert.throws(() => cancel(9999, at(0)), NotFound);
  ingest("ops", alert("x"), at(0));
  const job = claim("w2", at(0))!;
  finish(job.run, job.token, { outcome: "done", summary: "Хорошо" }, at(1));
  assert.throws(() => cancel(job.run, at(2)), InputError);
  const row = one<{ state: string; cancel_at: string | null }>("SELECT state, cancel_at FROM runs WHERE id = ?", [
    job.run,
  ])!;
  assert.deepEqual([row.state, row.cancel_at], ["done", null]);
});

test("a report of starting is bounded, and a refused one changes nothing", () => {
  clean();
  ingest("ops", alert("x"), at(0));
  const job = claim("w2", at(0))!;
  const reported = () => {
    const row = one<{ session: string | null; link: string | null }>("SELECT session, link FROM runs WHERE id = ?", [
      job.run,
    ])!;
    return [row.session, row.link];
  };
  for (const bad of [{ session: 42 }, { link: {} }, { session: "s".repeat(501) }, { link: "l".repeat(501) }])
    assert.throws(() => started(job.run, job.token, bad, at(1)), InputError, JSON.stringify(bad));
  assert.deepEqual(reported(), [null, null]);
  // The limit itself is allowed.
  started(job.run, job.token, { session: "s".repeat(500), link: "l".repeat(500) }, at(1));
  assert.deepEqual(reported(), ["s".repeat(500), "l".repeat(500)]);
});

test("a run's usage and session are kept", () => {
  clean();
  ingest("ops", alert("x"), at(0));
  const job = claim("w2", at(0))!;
  finish(
    job.run,
    job.token,
    { outcome: "done", summary: "Хорошо", session: "t-1", usage: { input: 100, output: 20, cached: 50, cost: 0.1 } },
    at(1),
  );
  const row = one<{ session: string; usage: string }>("SELECT session, usage FROM runs WHERE id = ?", [job.run])!;
  assert.equal(row.session, "t-1");
  assert.deepEqual(JSON.parse(row.usage), { input: 100, output: 20, cached: 50, cost: 0.1 });
});
