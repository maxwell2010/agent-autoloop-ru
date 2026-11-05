// The whole loop, with nothing faked but the agent: a real `agent-autoloop up` in its own process, from `init` on, through the
// protocol as everything else speaks it. An event comes in; the agent runs and asks; the owner answers from the command line;
// the agent goes on and finishes. Failure cases: init leaves something out; `up` doesn't start, or starts twice; the run isn't
// started in its folder; the question doesn't reach the owner; `status` doesn't show what to do about it; the answer doesn't
// wake the thread; the result isn't recorded; `try` hangs for an answer when nobody's at a terminal, as when an Agent runs it;
// the user's Agents aren't told how to set it up, or something of the user's own is overwritten doing so, or a test install does it;
// the question doesn't show on the desktop, shows again once answered, or a test run puts up a real notification.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "agent-autoloop-loop-"));
const bin = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
// `init` turns on the desktop channel: these stand in for the commands that would really show something.
const notifiers = join(home, "notifiers");
const notified = join(home, "notified.txt");
const notifications = () => (existsSync(notified) ? readFileSync(notified, "utf8").trim().split("\n") : []);
mkdirSync(notifiers);
writeFileSync(join(notifiers, "launchctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
for (const name of ["osascript", "notify-send"]) {
  const recordTitle = `while [ "$1" != "--" ]; do shift; done\nprintf '%s\\n' "$3" >> "${notified}"\n`;
  writeFileSync(join(notifiers, name), `#!/bin/sh\n${recordTitle}`);
  chmodSync(join(notifiers, name), 0o755);
}
const env: NodeJS.ProcessEnv = {
  ...process.env,
  AGENT_AUTOLOOP_HOME: home,
  DISPLAY: ":99",
  PATH: `${notifiers}:${process.env.PATH}`,
};
delete env.AGENT_AUTOLOOP_RULES;
delete env.AGENT_AUTOLOOP_PUBLIC_URL;
const cli = (...args: string[]) =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", bin, ...args], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

const fence = "```";
const script = join(home, "agent.sh");
writeFileSync(
  script,
  `#!/bin/sh
# Asks on its first go; with an answer in the context file, finishes. Asked to, it only says something.
if grep -q 'card.answered' "$AGENT_AUTOLOOP_CONTEXT"; then
  echo "Вы выбрали зеленый и все готово"
elif grep -q 'hello.notice' "$AGENT_AUTOLOOP_CONTEXT"; then
  cat <<'END'
说了Один声

${fence}agent-autoloop
{"notice":[{"title":"хранится意Один下","text":"磁盘Быстро满了","key":"disk"}]}
${fence}
END
else
  pwd > "${home}/where.txt"
  cat <<'END'
Задан вопрос

${fence}agent-autoloop
{"ask":[{"title":"Пробный запуск: выберите цвет","text":"选哪都行","options":["Синий","Зеленый"],"recommend":1,"key":"color"}]}
${fence}
END
fi
`,
);
chmodSync(script, 0o755);

let up: ReturnType<typeof spawn> | undefined;
after(async () => {
  if (up && up.exitCode === null && up.signalCode === null) {
    up.kill("SIGTERM");
    await new Promise((resolve) => up!.once("exit", resolve));
  }
  rmSync(home, { recursive: true, force: true });
});

test("one machine, one command: an event, a question, an answer, the work done", async () => {
  const port = await freePort();
  const done = cli("init", "--no-service", "--command", script, "--port", String(port));
  assert.equal(done.status, 0, done.stderr);
  assert.equal(statSync(join(home, "config.json")).mode & 0o777, 0o600, "its keys are private");
  assert.equal(cli("init", "--no-service").status, 1, "a second init doesn't overwrite the first");
  assert.equal(cli("check").status, 0);
  // Point the starter rule at something this test owns.
  const rules = JSON.parse(readFileSync(join(home, "rules.json"), "utf8"));
  mkdirSync(join(home, "work"));
  rules.rules[0].cwd = join(home, "work");
  rules.rules[0].when.types = ["hello.*", "try.*"];
  writeFileSync(join(home, "rules.json"), JSON.stringify(rules));

  up = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", bin, "up"], { env, stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  // `cli` holds up this process, so a connection kept open can time out at the hub unnoticed, and the next request on it
  // is reset. Each request gets its own.
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${url}${path}`, { headers: { connection: "close", ...headers } });
  for (let i = 0; i < 100; i++) {
    if (
      await get("/healthz").then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await (await get("/healthz")).json()).ok, true);
  const second = cli("up");
  assert.equal(second.status, 1);
  assert.match(second.stderr, /Уже запущен/);

  const emitted = cli("emit", "hello.world", "--subject", "x-1", "--summary", "Привет");
  assert.equal(emitted.status, 0, emitted.stderr);
  assert.match(emitted.stdout, /Передано:Пробный запуск/);

  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  const state = async () => (await get("/v1/state", { authorization: `Bearer ${config.owner}` })).json();
  const until = async (done: (s: any) => boolean) => {
    for (let i = 0; i < 150; i++) {
      const now = await state();
      if (done(now)) return now;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`timed out: ${JSON.stringify((await state()).runs)}`);
  };
  const asking = await until((s) => s.cards.length === 1);
  const card = asking.cards[0];
  assert.equal(card.title, "Пробный запуск: выберите цвет");
  assert.ok(readFileSync(join(home, "where.txt"), "utf8").includes("work"));
  const waiting = cli("status");
  assert.match(waiting.stdout, /Требуется ваше действие 1/);
  assert.match(waiting.stdout, new RegExp(`#${card.id} Пробный запуск: выберите цвет`));
  assert.match(waiting.stdout, /2\. Зеленый\(рекомендуется\)/);
  assert.match(waiting.stdout, new RegExp(`agent-autoloop answer ${card.id} `));

  // The notifier runs on its own, and a card answered before it gets there isn't shown at all.
  await until(() => notifications().length === 2);
  assert.equal(cli("answer", String(card.id), "7").status, 1, "there's no seventh option");
  const answered = cli("answer", String(card.id), "2");
  assert.equal(answered.status, 0, answered.stderr);
  const finished = await until((s) =>
    s.runs.some((r: any) => r.summary === "Вы выбрали зеленый и все готово" && r.state === "done"),
  );
  assert.equal(finished.cards.length, 0);
  assert.equal(finished.recentCards[0].state, "done");
  assert.equal(finished.recentCards[0].result, "Вы выбрали зеленый и все готово");
  assert.equal(finished.recentCards[0].by, "владелец");
  assert.deepEqual(
    notifications(),
    ["Пробный запуск: выберите цвет", "Выполните agent-autoloop status Просмотреть"],
    "once, and not for the answer",
  );
  assert.match(cli("answer", String(card.id), "1").stdout, /уже обработана/);

  const status = cli("status");
  assert.match(status.stdout, /Выполняется 0 · в очереди 0 · Завершено сегодня 2 · Требуется ваше действие 0/);
  assert.match(status.stdout, /Вы выбрали зеленый и все готово/);
  const told = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", bin, "tell", "note-1"], {
    env,
    encoding: "utf8",
    input: "Расскажу тебе\n",
  });
  assert.match(told.stdout, /Отправлено/);
  assert.match(cli("status").stdout, /Расскажу тебе/);
  cli("emit", "hello.notice");
  const noticed = await until((s) => s.cards.some((c: any) => c.kind === "notice"));
  const notice = noticed.cards.find((c: any) => c.kind === "notice");
  assert.match(cli("status").stdout, new RegExp(`Обработано:agent-autoloop answer ${notice.id}`));
  assert.match(cli("answer", String(notice.id)).stdout, /Карточка закрыта/);

  // Nobody at a terminal, as when an Agent is installing it: `try` says what's being asked and how to answer, and doesn't wait.
  const tried = cli("try");
  assert.equal(tried.status, 0, tried.stderr);
  assert.match(tried.stdout, /Пробный запуск: выберите цвет/);
  const id = /agent-autoloop answer (\d+) /.exec(tried.stdout)![1];
  const resolved = cli("resolve", id, "Больше никаких попыток");
  assert.match(resolved.stdout, /Карточка закрыта/);
  assert.equal((await state()).recentCards.find((c: any) => c.id === Number(id)).result, "Больше никаких попыток");
  assert.equal(cli("resolve", id).status, 1, "a result has to be written");
  assert.equal((await get("/")).status, 404);
});

test("the user's Agents are shown how to set it up, when this is the install in its usual place, and nothing of theirs is touched", () => {
  const person = mkdtempSync(join(tmpdir(), "agent-autoloop-person-"));
  mkdirSync(join(person, ".claude"));
  mkdirSync(join(person, ".codex", "skills", "agent-autoloop"), { recursive: true });
  writeFileSync(join(person, ".codex", "skills", "agent-autoloop", "SKILL.md"), "their own");
  const usual: NodeJS.ProcessEnv = { ...env, HOME: person };
  delete usual.AGENT_AUTOLOOP_HOME;
  const done = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", bin, "init", "--no-service", "--command", "true"],
    { env: usual, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(done.status, 0, done.stderr);
  assert.equal(
    realpathSync(join(person, ".claude", "skills", "agent-autoloop")),
    realpathSync(join(import.meta.dirname, "..", "skills", "agent-autoloop")),
  );
  assert.ok(lstatSync(join(person, ".claude", "skills", "agent-autoloop")).isSymbolicLink());
  assert.equal(readFileSync(join(person, ".codex", "skills", "agent-autoloop", "SKILL.md"), "utf8"), "their own");
  assert.ok(existsSync(join(person, ".agent-autoloop", "config.json")));
  rmSync(person, { recursive: true, force: true });
  assert.ok(!existsSync(join(home, ".claude")), "an install somewhere else leaves the user's Agents alone");
});
