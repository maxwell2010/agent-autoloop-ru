// install.sh, in a throwaway home with a PATH made of nothing but temporary folders. The program it sets up is a copy of this
// one and `git` is a stand-in that makes that copy, so nothing needs committing and no real folder can be written to. Failure
// cases: the command goes somewhere that isn't on PATH, so `agent-autoloop` isn't found right after installing; someone's own
// agent-autoloop is overwritten; with nowhere to put it, or someone else's coming first, the next step printed doesn't work; the next
// step says `try` when nothing has been started; it asks for sudo; the Node advice can't be followed as written, leaving out
// that Homebrew's node@24 isn't on PATH; running it again redoes the setup, or installs a service after --no-service.
// A normal umask or a pre-existing directory must not expose the database, event text or worker output to other users.
// A computer that only takes work can't join, because the installer has set a hub up on it first.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const repo = join(import.meta.dirname, "..");
const script = join(repo, "install.sh");
const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-autoloop-install-")));
const copy = join(dir, "the-program");
for (const part of ["bin", "cli", "host", "kernel", "plugins", "protocol", "skills", "worker", "package.json"]) {
  cpSync(join(repo, part), join(copy, part), { recursive: true });
}
const locked: string[] = [];
after(() => {
  for (const folder of locked) chmodSync(folder, 0o755);
  rmSync(dir, { recursive: true, force: true });
});

const system = (name: string) => ["/bin", "/usr/bin"].map((place) => join(place, name)).find(existsSync)!;
const executable = (file: string, body: string) => {
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
};

let people = 0;
/** Somebody's computer: a home, and a folder of the commands the script needs that it can't write to. */
function computer({ node = "real" }: { node?: "real" | "old" | "none" } = {}) {
  const person = join(dir, `person-${++people}`);
  const tools = join(person, "tools");
  mkdirSync(tools, { recursive: true });
  for (const name of ["mkdir", "ln", "cat", "cp", "chmod", "sed", "sort", "tail"])
    symlinkSync(system(name), join(tools, name));
  const called = join(person, "called");
  executable(
    join(tools, "git"),
    `echo "git $*" >> "${called}"
case " $* " in *" clone "*) for target; do :; done; cp -R "${copy}" "$target"; mkdir "$target/.git" ;; esac
[ "$3" != config ] || echo https://github.com/maxwell2010/agent-autoloop-ru.git`,
  );
  // `launchctl print` failing says nothing's loaded, which is what lets a first load go ahead at once.
  executable(join(tools, "launchctl"), `echo "launchctl $*" >> "${called}"\n[ "$1" != print ]`);
  executable(join(tools, "systemctl"), `echo "systemctl $*" >> "${called}"`);
  if (node === "real") symlinkSync(process.execPath, join(tools, "node"));
  if (node === "old") executable(join(tools, "node"), `[ "$1" = -v ] && echo v22.1.0 || exit 1`);
  chmodSync(tools, 0o555);
  locked.push(tools);
  const hub = join(person, ".agent-autoloop");
  const program = join(hub, "app", "bin", "agent-autoloop.ts");
  const local = join(person, ".local", "bin");
  const run = (path: string[], args = ["--no-service", "--command", "true", "--port", "3999"], shell = "/bin/sh") => {
    const env: NodeJS.ProcessEnv = { HOME: person, PATH: [...path, tools].join(":") };
    return spawnSync(shell, [script, ...args], {
      env,
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  };
  return { person, tools, hub, program, local, called, run, folder: (name: string) => join(person, name) };
}
const made = (place: string) => {
  mkdirSync(place, { recursive: true });
  return place;
};
const isLink = (file: string) => lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() === true;

test("installation keeps data private even when its root already exists with mode 0755", () => {
  const it = computer();
  mkdirSync(it.hub, { mode: 0o755 });
  chmodSync(it.hub, 0o755);
  const done = it.run([it.local]);
  assert.equal(done.status, 0, done.stderr + done.stdout);
  assert.equal(statSync(it.hub).mode & 0o777, 0o700);
});

test("a computer that only takes work joins through the installer, with nothing of a hub set up on it", () => {
  const it = computer();
  const done = it.run([it.local], ["join", "https://hub.test", "--worker", "mac", "--key", "k", "--no-service"]);
  assert.equal(done.status, 0, done.stderr + done.stdout);
  assert.deepEqual(JSON.parse(readFileSync(join(it.hub, "config.json"), "utf8")), {
    url: "https://hub.test",
    worker: { name: "mac", key: "k" },
  });
  assert.match(done.stdout, /как исполнитель/);
  assert.equal(readlinkSync(join(it.local, "agent-autoloop")), it.program);
  // A second try, with the key corrected, must say it did nothing rather than that it updated.
  const again = it.run([it.local], ["join", "https://hub.test", "--worker", "mac", "--key", "other", "--no-service"]);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /Уже настроено/);
  assert.equal(JSON.parse(readFileSync(join(it.hub, "config.json"), "utf8")).worker.key, "k");
});

test("the command goes in ~/.local/bin when that's on PATH, even behind another place it could go", () => {
  const it = computer();
  const other = made(it.folder("other"));
  const done = it.run([other, it.local]);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(readlinkSync(join(it.local, "agent-autoloop")), it.program);
  assert.ok(!isLink(join(other, "agent-autoloop")));
  assert.match(
    done.stdout,
    /Сначала выполните agent-autoloop up, затем в другом терминале выполните agent-autoloop try/,
  );
  assert.doesNotMatch(done.stdout, /alias/);
});

test("the same goes for dash, which is what sh is on Ubuntu", { skip: !existsSync("/bin/dash") }, () => {
  const it = computer();
  const done = it.run([it.local], undefined, "/bin/dash");
  assert.equal(done.status, 0, done.stderr);
  assert.ok(isLink(join(it.local, "agent-autoloop")));
  assert.doesNotMatch(done.stdout, /alias/);
});

test("with ~/.local/bin not on PATH it goes in the first place that is, and leaves ~/.local/bin alone", () => {
  const it = computer();
  const first = made(it.folder("first"));
  const second = made(it.folder("second"));
  const done = it.run(["relative/bin", ".", it.folder("not-there"), first, second]);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(readlinkSync(join(first, "agent-autoloop")), it.program);
  assert.ok(!existsSync(it.local));
  assert.ok(!isLink(join(second, "agent-autoloop")));
  assert.match(done.stdout, /agent-autoloop try/);
  assert.doesNotMatch(done.stdout, /alias/);
});

test("someone's own agent-autoloop stays as it was, and the next step doesn't send them to it", () => {
  const it = computer();
  const theirs = made(it.local);
  executable(join(theirs, "agent-autoloop"), "echo their own");
  const after = made(it.folder("after"));
  const done = it.run([theirs, after]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(readFileSync(join(theirs, "agent-autoloop"), "utf8"), /echo their own/);
  assert.equal(readlinkSync(join(after, "agent-autoloop")), it.program);
  assert.match(done.stdout, new RegExp(`Сначала выполните ${it.program} up`));
  assert.match(done.stdout, new RegExp(`alias agent-autoloop='${it.program}'`));

  const linked = computer();
  const place = made(linked.local);
  symlinkSync(join(place, "somewhere-else"), join(place, "agent-autoloop"));
  assert.equal(linked.run([place]).status, 0);
  assert.equal(readlinkSync(join(place, "agent-autoloop")), join(place, "somewhere-else"));
});

test(
  "with nowhere on PATH to put it, the next step gives the full path and no link is left anywhere",
  { skip: process.getuid?.() === 0 },
  () => {
    const it = computer();
    const done = it.run([]);
    assert.equal(done.status, 0, done.stderr);
    assert.ok(!existsSync(it.local));
    assert.match(
      done.stdout,
      new RegExp(`Сначала выполните ${it.program} up, затем в другом терминале выполните ${it.program} try`),
    );
    assert.match(done.stdout, new RegExp(`alias agent-autoloop='${it.program}'`));
    assert.doesNotMatch(readFileSync(script, "utf8"), /sudo/);
  },
);

test("the next step is try alone when a service has been started", () => {
  const it = computer();
  const done = it.run([it.local], ["--command", "true", "--port", "3999"]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /Выполните agent-autoloop try Выполнить полный цикл/);
  assert.doesNotMatch(done.stdout, /agent-autoloop up/);
});

for (const [node, words] of [
  ["old", /Требуется Node\.js 24 или новее, сейчас установлен v22\.1\.0/],
  ["none", /Требуется Node\.js 24 или новее; Node на этом компьютере не найден/],
] as const) {
  test(`with Node ${node === "old" ? "too old" : "missing"} it says what to run, and those lines work as written`, () => {
    const it = computer({ node });
    const done = it.run([]);
    assert.equal(done.status, 1);
    assert.match(done.stdout, words);
    assert.match(done.stdout, /^ +brew install node@24$/m);
    assert.match(done.stdout, /^ +nvm install 24$/m);
    assert.ok(!existsSync(it.hub), "nothing is set up");
    // The line about PATH, as it's printed, run where `brew --prefix` answers as Homebrew does.
    const shell = made(it.folder("shell"));
    executable(join(shell, "brew"), `[ "$*" = "--prefix node@24" ] && echo /homebrew/opt/node@24`);
    const line = done.stdout.split("\n").find((printed) => printed.includes("brew --prefix"))!;
    const pasted = spawnSync("/bin/sh", ["-c", line.trim()], {
      env: { HOME: shell, PATH: shell },
      encoding: "utf8",
    });
    assert.equal(pasted.status, 0, pasted.stderr);
    assert.equal(readFileSync(join(shell, ".zshrc"), "utf8"), 'export PATH="/homebrew/opt/node@24/bin:$PATH"\n');
  });
}

test("running it again updates and doesn't set anything up over what's there", () => {
  const it = computer();
  assert.equal(it.run([it.local]).status, 0);
  writeFileSync(join(it.hub, "rules.json"), "my rules");
  const config = readFileSync(join(it.hub, "config.json"), "utf8");
  rmSync(it.called);
  const kept = it.run([it.local]);
  assert.equal(kept.status, 0, kept.stderr);
  assert.match(kept.stdout, /Обновление завершено/);
  assert.equal(readFileSync(join(it.hub, "rules.json"), "utf8"), "my rules");
  assert.equal(readFileSync(join(it.hub, "config.json"), "utf8"), config);
  assert.equal(readlinkSync(join(it.local, "agent-autoloop")), it.program);
  // This stand-in lists no releases. What happens with some is in releases.test.ts, with the real git.
  assert.deepEqual(readFileSync(it.called, "utf8").trim().split("\n"), [
    `git -C ${join(it.hub, "app")} config --get remote.origin.url`,
    "git ls-remote --refs --tags https://github.com/maxwell2010/agent-autoloop-ru.git v*",
    `git -C ${join(it.hub, "app")} pull --ff-only --quiet`,
  ]);

  rmSync(it.called);
  assert.equal(it.run([it.local], []).status, 0);
  const service = process.platform === "darwin" ? /^launchctl bootstrap /m : /^systemctl --user enable --now /m;
  assert.match(readFileSync(it.called, "utf8"), service, "without --no-service an update restarts the service");
});
