// The rules file is what the owner changes by asking an Agent, so a mistake must be caught, say which rule and what is
// wrong, and leave the old rules running. Failure cases: a rule naming a source or agent that isn't there; two rules with
// one name; a rule matching no event or with both a source and a schedule; a schedule that is malformed or never comes; an
// unknown way of telling; an agent without a worker, with an unknown access level, or a command without a command line; a
// rule that sends its work to an ACP agent with no command line, which only shows when it runs and then fails ten times, or
// an ACP agent like that which no rule uses and which never hurt anyone being refused; a rule with neither a skill nor a
// prompt, or without a folder; a misspelt field taken silently; a rule running more than one at a time without saying how many, or
// rules in one group disagreeing on it; an emit naming a source that isn't there; a scheduled task shown on the page naming a source or agent that isn't there or a malformed schedule; a time zone
// that doesn't exist; the reserved source redefined; a null rule crashes reload instead of keeping the old rules.
// A good file changing on disk takes effect; a bad one doesn't, and says why. A file that is gone or can't be read
// crashes the hub, at reload or at restart, instead of keeping the rules it had. A file broken while the hub was down
// is never told, because nothing about it changes after startup has read it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("rules");
const { parseRules, RulesError, rules, ruleNamed, reloadRules } = await import("../host/runtime.ts");
const { typeMatches } = await import("../kernel/rules.ts");

const good = () => JSON.parse(readFileSync(join(import.meta.dirname, "rules.fixture.json"), "utf8"));
const problem = (change: (r: any) => void, words: RegExp) => {
  const r = good();
  change(r);
  assert.throws(
    () => parseRules(JSON.stringify(r)),
    (error: Error) => {
      assert.ok(error instanceof RulesError);
      assert.match(error.message, words);
      return true;
    },
  );
};

test("the fixture loads, with defaults filled in", () => {
  const r = parseRules(JSON.stringify(good()));
  assert.equal(r.rules[0].tell, "needed");
  assert.equal(r.rules[2].group, "Тревога также записывается.", "a rule's group defaults to its own name");
  assert.ok(r.askFirst.includes("Удаление данных"));
  assert.equal(r.sources.schedule.name, "Расписание");
  assert.equal(r.agents.a1.access, "edit", "the safe level unless the rule's author asks otherwise");
  assert.equal(r.agents.a2.access, "full");
  const acp = good();
  acp.agents.a1.use = "acp";
  acp.agents.a1.command = ["acp-program"];
  assert.equal(parseRules(JSON.stringify(acp)).agents.a1.use, "acp", "an ACP agent with its command line is fine");
  const spare = good();
  spare.agents.spare = { name: "Зарезервировано", worker: "w1", use: "acp" };
  assert.equal(
    parseRules(JSON.stringify(spare)).agents.spare.use,
    "acp",
    "no rule sends it anything, so nothing fails",
  );
});

test("a mistake says which rule and what is wrong", () => {
  problem((r) => {
    r.rules[0].to = "nobody";
  }, /Правило «Мнение».*to.*Не зарегистрирован Agent:nobody/);
  problem((r) => {
    r.rules[0].when.source = "nowhere";
  }, /Правило «Мнение».*источник.*nowhere/);
  problem((r) => {
    r.rules[1].name = "Мнение";
  }, /Имя правила «Мнение» повторяется/);
  problem((r) => {
    r.rules[0].when.types = [];
  }, /Правило «Мнение».*types/);
  problem((r) => {
    r.rules[0].when.cron = "0 9 * * *";
  }, /Правило «Мнение».*when/);
  problem((r) => {
    r.rules[3].when.cron = "99 * * * *";
  }, /Правило «Утренний обзор».*cron/);
  problem((r) => {
    r.rules[3].when.cron = "0 0 30 2 *";
  }, /Правило «Утренний обзор».*расписание никогда не наступит/);
  problem((r) => {
    r.rules[0].tell = "sometimes";
  }, /Правило «Мнение».*tell/);
  problem((r) => {
    delete r.rules[0].cwd;
  }, /Правило «Мнение»: отсутствует cwd/);
  problem((r) => {
    r.rules[0].cwd = "relative/path";
  }, /Правило «Мнение».*cwd/);
  problem((r) => {
    delete r.rules[1].prompt;
  }, /Правило «Тревога».*skill.*prompt/);
  problem((r) => {
    r.rules[0].oops = 1;
  }, /Правило «Мнение»: содержит неизвестное поле oops/);
  problem((r) => {
    delete r.rules[0].parallel;
    r.rules[1].group = "notes";
    r.rules[1].parallel = 2;
  }, /Группа «notes».*parallel/);
  problem((r) => {
    r.rules[0].parallel = 0;
  }, /Правило «Мнение».*parallel/);
  problem((r) => {
    r.rules[0].resume = "thread";
  }, /Правило «Мнение».*resume/);
  problem((r) => {
    r.rules[4].emits.source = "nowhere";
  }, /Правило «Осмотр».*emits/);
  problem((r) => {
    delete r.agents.a1.worker;
  }, /Agent a1: отсутствует worker/);
  problem((r) => {
    r.agents.a1.access = "root";
  }, /Agent a1.*access/);
  problem((r) => {
    delete r.agents.a3.command;
  }, /Agent a3.*command/);
  problem((r) => {
    r.agents.a1.use = "acp";
  }, /Правило «Мнение»используется Agent a1 Отсутствует command/);
  problem((r) => {
    r.agents.a1.oops = 1;
  }, /Agent a1: содержит неизвестное поле oops/);
  problem((r) => {
    r.sources.schedule = { name: "x" };
  }, /schedule.*зарезервировано/);
  problem((r) => {
    r.sources["Bad Id"] = { name: "x" };
  }, /ID источника/);
  problem((r) => {
    r.channels.chat.answerers = "me";
  }, /канал chat.*answerers/);
  problem((r) => {
    r.elsewhere[0].to = "nobody";
  }, /Запланированная задача «Еженедельная очистка».*to/);
  problem((r) => {
    r.elsewhere[0].source = "nowhere";
  }, /Запланированная задача «Еженедельная очистка».*source/);
  problem((r) => {
    r.elsewhere[0].cron = "nope";
  }, /Запланированная задача «Еженедельная очистка».*cron/);
  problem((r) => {
    r.elsewhere[0].name = "Мнение";
  }, /Запланированная задача «Мнение».*повторяется/);
  problem((r) => {
    r.timezone = "Mars/Olympus";
  }, /timezone/);
  problem((r) => {
    r.askFirst = "Удаление данных";
  }, /askFirst/);
  assert.throws(() => parseRules("{ not json"), /Некорректный JSON/);
});

test("types match exactly, by prefix or all", () => {
  assert.ok(typeMatches(["feedback.*"], "feedback.new"));
  assert.ok(!typeMatches(["feedback.*"], "feedbackx.new"));
  assert.ok(typeMatches(["alert.raised"], "alert.raised"));
  assert.ok(!typeMatches(["alert.raised"], "alert.raised.more"));
  assert.ok(typeMatches(["*"], "anything"));
});

test("a null rule is a rules error and leaves the running configuration intact", () => {
  problem((r) => {
    r.rules = [null];
  }, /объект/);
  const file = join(home, "null-rules.json");
  const broken = good();
  broken.rules = [null];
  writeFileSync(file, JSON.stringify(broken));
  const answer = reloadRules(file);
  assert.equal(answer.changed, false);
  assert.match(answer.problem!, /объект/);
  assert.equal(ruleNamed("Мнение")!.to, "a1");
});

test("what's loaded can be read back", () => {
  assert.equal(ruleNamed("Утренний обзор")!.to, "a1");
  assert.equal(ruleNamed("отсутствует这条"), undefined);
  assert.equal(rules.timezone, "Asia/Shanghai");
});

test("a good file changing on disk takes effect; a bad one leaves the old rules and says why", () => {
  const file = join(home, "rules.json");
  process.env.AGENT_AUTOLOOP_RULES = file;
  const changed = good();
  changed.rules[0].prompt = "новыйдля说法.";
  writeFileSync(file, JSON.stringify(changed));
  assert.deepEqual(reloadRules(file), { changed: true });
  assert.equal(ruleNamed("Мнение")!.prompt, "новыйдля说法.");
  assert.deepEqual(reloadRules(file), { changed: false }, "nothing new on disk");
  const broken = good();
  broken.rules[0].to = "nobody";
  writeFileSync(file, JSON.stringify(broken));
  const answer = reloadRules(file);
  assert.equal(answer.changed, false);
  assert.match(answer.problem!, /nobody/);
  assert.equal(ruleNamed("Мнение")!.prompt, "новыйдля说法.", "the old rules keep running");
});

test("a rules file that can't be read is a problem, not a crash, and the old rules keep running", () => {
  const answer = reloadRules(join(home, "gone.json"));
  assert.equal(answer.changed, false);
  assert.match(answer.problem!, /Не найдено/);
  assert.equal(ruleNamed("Мнение")!.prompt, "новыйдля说法.");
  assert.match(reloadRules(home).problem!, /Недоступно для чтения/, "a folder where the file should be");
});

test("a rules file broken while the hub was down is told at the first tick, unless it's fixed by then", () => {
  const down = join(home, "down");
  mkdirSync(down);
  const file = join(down, "rules.json");
  const start = (afterStarting = "") => {
    const started = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        `const hub = await import(${JSON.stringify(new URL("../host/runtime.ts", import.meta.url).href)});` +
          `const { rows } = await import(${JSON.stringify(new URL("../kernel/evolve.ts", import.meta.url).href)});` +
          `${afterStarting}; hub.tick();` +
          `console.log(JSON.stringify(rows(hub.getView(), "cards", { state: "open" }).map((card) => card.title)))`,
      ],
      { env: { ...process.env, AGENT_AUTOLOOP_HOME: down, AGENT_AUTOLOOP_RULES: file }, encoding: "utf8" },
    );
    assert.equal(started.status, 0, started.stderr);
    return JSON.parse(started.stdout);
  };
  writeFileSync(file, JSON.stringify(good()));
  assert.deepEqual(start(), []);
  const broken = good();
  broken.rules[0].to = "nobody";
  writeFileSync(file, JSON.stringify(broken));
  assert.deepEqual(start(), ["rules.json Неправильное написание, все еще по старым правилам."]);
  const fix = `(await import("node:fs")).writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(JSON.stringify(good()))})`;
  assert.deepEqual(start(fix), [], "fixed by then, and the card from before is gone too");
});

test("a hub restarting without its rules file comes up on the rules it had; a new one without any says why", () => {
  const start = (env: Record<string, string>) =>
    spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        `const hub = await import(${JSON.stringify(new URL("../host/runtime.ts", import.meta.url).href)});` +
          `console.log(hub.ruleNamed("Мнение")?.prompt)`,
      ],
      { env: { ...process.env, ...env }, encoding: "utf8" },
    );
  const restarted = start({ AGENT_AUTOLOOP_RULES: join(home, "gone.json") });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.equal(restarted.stdout.trim(), "новыйдля说法.", "the rules it last loaded, not the fixture's");
  const fresh = start({ AGENT_AUTOLOOP_HOME: join(home, "fresh"), AGENT_AUTOLOOP_RULES: join(home, "gone.json") });
  assert.notEqual(fresh.status, 0);
  assert.match(fresh.stderr, /Не найдено/);
});
