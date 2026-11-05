// Failure modes: an owner question with backticks in its title or text cuts the receipt short; a short commit from the health
// check can't be fetched, so every change needs a release and a docs-only PR never finishes; a failure on an ordinary issue is
// covered up by the 404 from looking it up as a PR; one item whose label record can't be read fails the whole poll; a failed
// round writes its error over the delivery status, so the next one forgets the commit had findings and reviews it again; a
// release failing after a PR was merged during review loses what the review found, as the next round doesn't review.
// Nothing here reaches GitHub: `gh` is a stand-in first on PATH, and the Git remote is a local folder.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createIO } from "../plugins/delivery/github.ts";
import { poll } from "../plugins/delivery/poll.ts";
import { run } from "../plugins/delivery/run.ts";
import { readMessage, resultFrom } from "../worker/contract.ts";

const root = mkdtempSync(join(tmpdir(), "agent-autoloop-delivery-run-"));
after(() => rmSync(root, { recursive: true, force: true }));
const bin = join(root, "bin");
const routes = join(root, "routes.json");
const calls = join(root, "calls.txt");
const statuses = join(root, "statuses.txt");
mkdirSync(bin);
writeFileSync(
  join(bin, "gh"),
  `#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs");
const { FAKE_GH_CALLS, FAKE_GH_ROUTES, FAKE_GH_STATUSES } = process.env;
const args = process.argv.slice(2);
appendFileSync(FAKE_GH_CALLS, args.join(" ") + "\\n");
const answer = JSON.parse(readFileSync(FAKE_GH_ROUTES, "utf8"))[args[1]];
const written = /\\/statuses\\/(\\w+)$/.exec(args[1]);
const asked = /\\/commits\\/(\\w+)\\/status\\?/.exec(args[1]);
if (answer?.fail || (answer === undefined && !written && !asked)) {
  console.error(answer?.fail ?? "gh: Not Found (HTTP 404)");
  process.exit(1);
}
if (written) {
  appendFileSync(FAKE_GH_STATUSES, JSON.stringify({ sha: written[1], ...JSON.parse(readFileSync(0, "utf8")) }) + "\\n");
  console.log("{}");
} else if (asked) {
  const lines = readFileSync(FAKE_GH_STATUSES, "utf8").split("\\n").filter(Boolean);
  const newestFirst = lines.map((line) => JSON.parse(line)).filter((item) => item.sha === asked[1]).reverse();
  console.log(JSON.stringify({ statuses: newestFirst.filter((item, at) => newestFirst.findIndex((other) => other.context === item.context) === at) }));
} else {
  console.log(JSON.stringify(args.includes("--slurp") ? [answer] : answer));
}
`,
  { mode: 0o755 },
);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.FAKE_GH_ROUTES = routes;
process.env.FAKE_GH_CALLS = calls;
process.env.FAKE_GH_STATUSES = statuses;
writeFileSync(statuses, "");
/** What the stand-in answers from here on, by the path after `gh api`, and a clean list of what it was asked. */
const answers = (table: object) => {
  writeFileSync(routes, JSON.stringify(table));
  writeFileSync(calls, "");
};
const issue = (number: number, fields: object = {}) => ({
  number,
  state: "open",
  title: "требуется决定",
  body: "请决定",
  html_url: `https://github.com/example/app/issues/${number}`,
  labels: [{ name: "ask-owner" }],
  ...fields,
});
const about = (number: number) => ({ events: [{ subject: `example/app#${number}` }] });

test("an owner question with backticks reaches the hub whole", async () => {
  const title = "```标题";
  answers({ "repos/example/app/issues/5": issue(5, { title, body: "还有\n```\n没收尾дляКодовый блок" }) });
  const { problem, receipt } = readMessage(await run("example/app", about(5)));
  assert.equal(problem, undefined);
  const [card] = (receipt as any).ask;
  assert.equal(card.title, title);
  assert.match(card.text, /没收尾дляКодовый блок/);
});

const remote = join(root, "remote");
const gitConfig = join(root, "gitconfig");
writeFileSync(
  gitConfig,
  `[url "file://${remote}"]\n\tinsteadOf = https://github.com/example/app.git\n[user]\n\tname = t\n\temail = t@t\n`,
);
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: remote, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function publish(name: string, words: string) {
  writeFileSync(join(remote, name), words);
  git("add", "-A");
  git("commit", "-q", "-m", words);
  return git("rev-parse", "HEAD");
}
mkdirSync(join(remote, "docs"), { recursive: true });
git("init", "-q", "-b", "main");
writeFileSync(join(remote, "app.ts"), "1");
writeFileSync(join(remote, "AGENTS.md"), "## Точки обзора\nтребуется点\n");
const live = publish("docs/a.md", "first");
const docsOnly = publish("docs/a.md", "second");
const code = publish("app.ts", "2");
const internal = ["docs/*.md"];
const ioIn = (name: string) => {
  const folder = join(root, name);
  mkdirSync(folder);
  return createIO("example/app", folder);
};

test("a short commit from the health check is made full before comparing", async () => {
  const short = live.slice(0, 7);
  answers({ [`repos/example/app/commits/${short}`]: { sha: live } });
  const io = ioIn("short");
  assert.equal(await io.releaseRequired(short, docsOnly, internal), false);
  assert.equal(await io.releaseRequired(short, code, internal), true);
});
test("a full commit is compared as it is, without asking GitHub", async () => {
  answers({});
  const io = ioIn("full");
  assert.equal(await io.releaseRequired(live, docsOnly, internal), false);
  assert.ok(!readFileSync(calls, "utf8").includes("commits/"));
});
test("a short commit GitHub doesn't know means a release", async () => {
  answers({});
  assert.equal(await ioIn("unknown").releaseRequired("abcdef0", docsOnly, internal), true);
});

test("a failure on an ordinary issue is reported as it happened", async () => {
  answers({
    "repos/example/app/issues/5": issue(5),
    "repos/example/app/issues/5/labels/ask-owner": { fail: "permission denied" },
  });
  const answered = { ...about(5), answers: [{ text: "Обработано" }] };
  await assert.rejects(() => run("example/app", answered), /permission denied/);
  assert.ok(!readFileSync(calls, "utf8").includes("pulls/5"));
});
test("a failed delivery still marks the commit it stopped on", async () => {
  const fork = { number: 7, state: "open", labels: [{ name: "deliver" }], base: { ref: "main" } };
  const pr = { ...fork, head: { sha: "abc", repo: { full_name: "fork/app" } } };
  answers({
    "repos/example/app/issues/7": { ...fork, pull_request: {} },
    "repos/example/app/pulls/7": pr,
    "repos/example/app/statuses/abc": {},
  });
  await assert.rejects(() => run("example/app", about(7)), /этого репозитория/);
  assert.match(readFileSync(calls, "utf8"), /statuses\/abc --method POST/);
});
test("an item whose label record can't be read does not hold up the others", async () => {
  answers({
    "repos/example/app/issues?state=all&labels=deliver&per_page=100": [
      { number: 1, pull_request: {} },
      { number: 2, pull_request: {} },
    ],
    "repos/example/app/issues?state=all&labels=ask-owner&per_page=100": [],
    "repos/example/app/issues/1/events?per_page=100": [],
    "repos/example/app/issues/2/events?per_page=100": [{ event: "labeled", id: 9, label: { name: "deliver" } }],
    "repos/example/app/pulls/1": { state: "open", head: { sha: "aaa" } },
    "repos/example/app/pulls/2": { state: "open", head: { sha: "bbb" } },
  });
  const events = await poll("example/app");
  assert.deepEqual(
    events.map((event) => event.id),
    ["example/app#1:0:aaa", "example/app#2:9:bbb"],
  );
});

const reviewer = join(root, "reviewer.mjs");
const plan = join(root, "plan.json");
const reviews = join(root, "reviews.txt");
writeFileSync(
  reviewer,
  `import fs from "node:fs";
for await (const _ of process.stdin);
fs.appendFileSync(${JSON.stringify(reviews)}, "x");
const { findings, next } = JSON.parse(fs.readFileSync(${JSON.stringify(plan)}, "utf8"));
if (next) fs.writeFileSync(${JSON.stringify(routes)}, JSON.stringify(next));
console.log(JSON.stringify({ findings }));
`,
);
/** What the stand-in reviewer finds, and what the stand-in `gh` answers once it has looked. */
const reviewFinds = (findings: object[], next?: object) => writeFileSync(plan, JSON.stringify({ findings, next }));
const timesReviewed = () => readFileSync(reviews, "utf8").length;
const lastStatus = (context: string) =>
  readFileSync(statuses, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((item) => item.context === context)
    .at(-1);
const startOver = () => {
  writeFileSync(statuses, "");
  writeFileSync(reviews, "");
};
const settingsPath = `repos/example/app/contents/ops/delivery.json?ref=${live}`;
const settingsFile = {
  content: Buffer.from(
    JSON.stringify({
      repo: "example/app",
      internal,
      review: { points: "AGENTS.md", status: "my-review", command: [process.execPath, reviewer] },
      health: { url: "http://127.0.0.1:1/health", field: "commit", pattern: "(?P<sha>[0-9a-f]{40})" },
    }),
  ).toString("base64"),
};
const openPr = {
  number: 8,
  state: "open",
  draft: false,
  merged_at: null,
  merge_commit_sha: null,
  auto_merge: null,
  labels: [{ name: "deliver" }],
  head: { sha: code, repo: { full_name: "example/app" } },
  base: { ref: "main" },
  user: { login: "owner" },
};
/** PR 8 of the local remote, on its way to main at the first commit. */
const delivering = (pr: object) => ({
  "repos/example/app/issues/8": { number: 8, labels: [{ name: "deliver" }], pull_request: {} },
  "repos/example/app/pulls/8": pr,
  "repos/example/app/git/ref/heads/main": { object: { sha: live } },
  [settingsPath]: settingsFile,
  [`repos/example/app/compare/${live}...${code}`]: { status: "ahead" },
});
const dataLoss = [{ title: "数据会丢", text: "Сначала отремонтируйте" }];

test("a failed round in between does not open a commit with findings to another review", async () => {
  startOver();
  reviewFinds(dataLoss);
  answers(delivering(openPr));
  const first = readMessage(await run("example/app", about(8), true));
  assert.equal((first.receipt as any).notice.length, 1);
  assert.equal(timesReviewed(), 1);
  // The settings can't be read this time, and the failure goes on the delivery status over what the review wrote there.
  answers({ ...delivering(openPr), [settingsPath]: { fail: "HTTP 502" } });
  await assert.rejects(() => run("example/app", about(8), true), /HTTP 502/);
  assert.doesNotMatch(lastStatus("delivery").description, /Просмотр обнаруженных проблем/);
  // A review now would miss the problem, and nothing else would stand between it and the merge.
  reviewFinds([]);
  answers(delivering(openPr));
  const third = await run("example/app", about(8), true).catch((error) => error.message);
  assert.equal(timesReviewed(), 1);
  assert.equal(lastStatus("my-review").state, "failure");
  assert.match(third, /новый коммит/);
});

const merged = { ...openPr, state: "closed", merged_at: "now", merge_commit_sha: code };
const failedShip = {
  ...delivering(merged),
  "repos/example/app/actions/workflows/ship.yml/runs?branch=main&event=push&per_page=100": {
    workflow_runs: [{ id: 1, head_sha: code, event: "push", status: "completed", conclusion: "failure" }],
  },
};
test("a release failing after a PR was merged during review still hands on the findings", async () => {
  startOver();
  reviewFinds(dataLoss, failedShip);
  answers(delivering(openPr));
  const { result, problem } = resultFrom(readMessage(await run("example/app", about(8), true)), {});
  assert.equal(problem, undefined);
  assert.equal(result.outcome, "failed");
  assert.match(result.error!, /релиз не прошел/);
  const [card] = result.notice!;
  assert.match(card.title, /объединенных изменений/);
  assert.match(card.text, /数据会丢/);
  assert.equal(lastStatus("delivery").state, "failure");
  // The next round doesn't review, so it has nothing to say twice.
  await assert.rejects(() => run("example/app", about(8), true), /релиз не прошел/);
  assert.equal(timesReviewed(), 1);
});
test("GitHub failing while that failure is written down does not lose the findings either", async () => {
  startOver();
  reviewFinds(dataLoss, { ...failedShip, [`repos/example/app/statuses/${code}`]: { fail: "HTTP 502" } });
  answers(delivering(openPr));
  const { result } = resultFrom(readMessage(await run("example/app", about(8), true)), {});
  assert.equal(result.outcome, "failed");
  assert.match(result.notice![0].text, /数据会丢/);
});
test("a failed release with nothing found stays a plain failure", async () => {
  startOver();
  answers(failedShip);
  await assert.rejects(() => run("example/app", about(8), true), /релиз не прошел/);
  assert.equal(lastStatus("delivery").state, "failure");
  assert.equal(timesReviewed(), 0);
});
