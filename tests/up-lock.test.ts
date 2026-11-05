// Who holds up.pid. Failure cases: the number left behind is this very process's own (always so for pid 1 in a container, and
// possible after any restart), so it says it's already running and can't start until someone deletes the file; a second one
// starts beside one that really is running.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const bin = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const program = ["--disable-warning=ExperimentalWarning", bin];

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

test("a number left in up.pid that is now its own doesn't stop it starting; a second one still can't", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "agent-autoloop-up-lock-"));
  const standIns = join(home, "stand-ins");
  mkdirSync(standIns);
  for (const name of ["launchctl", "osascript", "notify-send"]) {
    writeFileSync(join(standIns, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_AUTOLOOP_HOME: home,
    DISPLAY: ":99",
    PATH: `${standIns}:${process.env.PATH}`,
    SHELL: "/bin/sh",
  };
  delete env.AGENT_AUTOLOOP_RULES;
  delete env.AGENT_AUTOLOOP_PUBLIC_URL;
  const port = await freePort();
  const init = spawnSync(
    process.execPath,
    [...program, "init", "--no-service", "--command", "true {prompt}", "--port", String(port)],
    { env, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(init.status, 0, init.stderr);

  // exec keeps the shell's number, so the file names the process that's about to read it, as a restart that drew it would.
  const wrote = 'printf %s "$$" > "$AGENT_AUTOLOOP_HOME/up.pid"; exec "$@"';
  const up = spawn("/bin/sh", ["-c", wrote, "sh", process.execPath, ...program, "up"], { env, stdio: "ignore" });
  const ended = new Promise((resolve) => up.once("exit", resolve));
  t.after(async () => {
    up.kill("SIGTERM");
    await ended;
    rmSync(home, { recursive: true, force: true });
  });

  const { url } = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  let ready = false;
  for (let i = 0; i < 100 && !ready && up.exitCode === null; i++) {
    ready = await fetch(`${url}/healthz`).then(
      (response) => response.ok,
      () => false,
    );
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, "it started");
  assert.equal(readFileSync(join(home, "up.pid"), "utf8"), String(up.pid));

  const second = spawnSync(process.execPath, [...program, "up"], { env, encoding: "utf8", timeout: 30_000 });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /Уже запущен/);
});
