// One pull request from label to live: review, full check, merge, Ship, health. Every step reads GitHub's state back
// rather than trusting its own last response, and a failure is left for the hub's retry to pick up where it stands.
import { settings, type Live, type Settings } from "./project.ts";
import type { Finding } from "./review.ts";

export type DeliveryIO = {
  api(path: string, body?: any, method?: string): Promise<any>;
  review(pr: any, config: Settings, main: string): Promise<Finding[]>;
  merge(pr: any, config: Settings): Promise<void>;
  disableAuto(number: number): Promise<void>;
  contains(base: string, head: string): Promise<boolean>;
  releaseRequired(base: string, head: string, patterns: string[]): Promise<boolean>;
  live(config: Settings): Promise<Live | null>;
  wait(): Promise<void>;
};
export type Delivered = { summary: string; merged?: string; reviewOnly?: boolean; findings?: Finding[]; head?: string };

const FINDINGS =
  "Если во время проверки обнаружена проблема, она будет повторно рассмотрена только после того, как будет исправлена новая подача.";
const labels = (pr: any) => new Set<string>((pr.labels ?? []).map((label: any) => label.name));
const newestFirst = (a: any, b: any) => b.id - a.id;

export const status = (io: DeliveryIO, head: string, context: string, state: string, description: string) =>
  io.api(`statuses/${head}`, { state, context, description: [...description].slice(0, 140).join("") }, "POST");

export async function disableAuto(number: number, io: DeliveryIO) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await io.disableAuto(number);
    } catch {
      /* A lost mutation response must be read back, not assumed. */
    }
    try {
      if (!(await io.api(`pulls/${number}`)).auto_merge) return;
    } catch {
      /* Known failure: a failed read-back must still confirm cancellation within three attempts. */
    }
    if (attempt < 2) await io.wait();
  }
  throw new Error("Не удалось подтвердить отключение автоматического слияния");
}

async function newestCheck(head: string, config: Settings, io: DeliveryIO) {
  const query = `head_sha=${head}&event=pull_request&per_page=100`;
  const { workflow_runs: runs } = await io.api(`actions/workflows/${config.check.workflow}/runs?${query}`);
  return runs.filter((run: any) => run.head_sha === head && run.event === "pull_request").sort(newestFirst)[0];
}

export async function fullCheck(
  head: string,
  config: Settings,
  io: DeliveryIO,
  after = 0,
): Promise<"passed" | "waiting" | "failed"> {
  const { job } = config.check;
  const run = await newestCheck(head, config, io);
  if (!run || run.id <= after) return "waiting";
  const jobs = (await io.api(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`)).jobs.filter(
    (candidate: any) => candidate.name === job || candidate.name.startsWith(`${job} (`),
  );
  if (!jobs.length) return "waiting";
  if (run.status === "completed" && run.conclusion !== "success") return "failed";
  const finished = (item: any) => item.status === "completed" && item.conclusion === "success";
  return finished(run) && jobs.every(finished) ? "passed" : "waiting";
}

export async function waitLive(merged: string, config: Settings, io: DeliveryIO) {
  if (!config.health) return;
  const query = "branch=main&event=push&per_page=100";
  for (;;) {
    const { workflow_runs } = await io.api(`actions/workflows/${config.ship.workflow}/runs?${query}`);
    const runs = workflow_runs.sort(newestFirst);
    const covering = [];
    for (const run of runs) if (run.event === "push" && (await io.contains(merged, run.head_sha))) covering.push(run);
    const live = await io.live(config);
    if (live) {
      for (const run of covering) {
        if (run.status !== "completed" || run.conclusion !== "success") continue;
        const liveHasIt = await io.contains(run.head_sha, live.sha);
        if (liveHasIt || !(await io.releaseRequired(live.sha, run.head_sha, config.internal))) return;
      }
    }
    const newest = covering[0];
    if (newest?.status === "completed" && newest.conclusion !== "success") {
      throw new Error(
        "Уже слит, релиз не прошел; отправьте повторно после исправления версии, не отправляйте код повторно",
      );
    }
    await io.wait();
  }
}

async function clearLabels(number: number, pr: any, io: DeliveryIO) {
  // A retry goes by what's left on. A merged PR only goes on to its release while it has `deliver`; an open one with `deliver`
  // alone is a full delivery, so a review-only one must lose `deliver-review` last or the retry merges it.
  const order = pr.merged_at ? ["deliver-review", "deliver"] : ["deliver", "deliver-review"];
  for (const label of ["deliver-attended", ...order]) {
    if (!labels(pr).has(label)) continue;
    try {
      await io.api(`issues/${number}/labels/${label}`, undefined, "DELETE");
    } catch (error) {
      // GitHub returned 404 after an observed labelled PR had already completed Ship; verify the desired state.
      if (labels(await io.api(`pulls/${number}`)).has(label)) throw error;
    }
  }
}

async function synced(number: number, head: string, base: string, io: DeliveryIO) {
  const until = Date.now() + 15 * 60_000;
  for (;;) {
    const pr = await io.api(`pulls/${number}`);
    if (pr.head.sha !== head && (await io.contains(base, pr.head.sha))) return pr;
    if (Date.now() > until)
      throw new Error(
        "Запрошена синхронизация main, 15 В течение нескольких минут не было обнаружено синхронизированных материалов. Повторите попытку позже.",
      );
    await io.wait();
  }
}

export async function deliver(
  repo: string,
  number: number,
  io: DeliveryIO,
  testLocalHealth = false,
): Promise<Delivered> {
  const reviewOnly = async (pr: any): Promise<Delivered> => {
    const summary = "Обзор пройден, не объединен и не выпущен";
    await status(io, pr.head.sha, "delivery", "success", summary);
    await clearLabels(number, pr, io);
    return { summary, reviewOnly: true };
  };
  let pr = await io.api(`pulls/${number}`);
  if (!labels(pr).has("deliver") || (!pr.merged_at && pr.state !== "open")) return { summary: "Нет меток доставки" };
  if (pr.head.repo?.full_name !== repo || pr.base.ref !== "main")
    throw new Error("Допускаются только PR из веток этого репозитория в main");
  if (pr.auto_merge) await disableAuto(number, io);
  const settingsAt = async (commit: string) => {
    const file = await io.api(`contents/ops/delivery.json?ref=${commit}`);
    const read = settings(JSON.parse(Buffer.from(file.content, "base64").toString("utf8")), testLocalHealth);
    if (read.repo !== repo) throw new Error("main для repo Настройки не соответствуют репозиторию доставки");
    return read;
  };
  let config = await settingsAt((await io.api("git/ref/heads/main")).object.sha);
  let head = pr.head.sha;
  if (!pr.merged_at) {
    // The label stays on after findings, so another event lands here: a second review that misses them would merge the commit.
    // The review status keeps the record, since a failed round writes its error over `delivery`.
    const { statuses } = await io.api(`commits/${head}/status?per_page=100`);
    if (statuses.some((item: any) => item.context === config.review.status && item.state === "failure"))
      return {
        summary: "В этом коммите уже найдены проблемы; для повторного ревью отправьте исправленный новый коммит",
      };
  }
  await status(io, head, "delivery", "pending", "Выполняются ревью, проверки и подтверждение публикации");
  let tooLate: Finding[] = [];
  // Sync inside the run: a thrown sync waits out the hub's growing retry backoff while main keeps moving.
  for (let round = 1; !pr.merged_at; round++) {
    let base = (await io.api("git/ref/heads/main")).object.sha;
    if (!(await io.contains(base, head))) {
      await io.api(`pulls/${number}/update-branch`, { expected_head_sha: head }, "PUT");
      pr = await synced(number, head, base, io);
      head = pr.head.sha;
      await status(
        io,
        head,
        "delivery",
        "pending",
        "Синхронизировано main, Выполняются ревью, проверки и подтверждение публикации",
      );
      // GitHub syncs with main as it is by then, which may be newer than what was read above: against the older one, those
      // commits would be reviewed as the branch's own.
      base = (await io.api("git/ref/heads/main")).object.sha;
      if (!(await io.contains(base, head))) {
        if (round < 3) continue;
        throw new Error("main Продвижение, повторная синхронизация и проверка позже");
      }
    }
    // The settings of the main this round is against: a newer one may add the health check its release has to pass.
    config = await settingsAt(base);
    const findings = await io.review(pr, config, base);
    const current = await io.api(`pulls/${number}`);
    // Someone merged it meanwhile: too late to hold it back, not too late to say what the review found.
    if (current.merged_at) {
      pr = current;
      tooLate = findings;
      break;
    }
    if (current.head.sha !== head) throw new Error("Коммит изменился во время проверки; дождитесь повторной доставки");
    if (findings.length) {
      await status(io, head, "delivery", "failure", FINDINGS);
      // Last: once this stands nothing reviews the commit again, so a failed write must not keep the findings from going out.
      await status(io, head, config.review.status, "failure", FINDINGS);
      return { summary: "В обзоре обнаружены проблемы, и он еще не объединен.", findings, head };
    }
    if (labels(current).has("deliver-review")) {
      return reviewOnly(current);
    }
    let after = 0;
    if (current.draft) {
      // Right after going ready the newest run is still a draft one: only a run started by the change can pass.
      after = (await newestCheck(head, config, io))?.id ?? 0;
      await io.api(`pulls/${number}/ready`, {}, "POST");
    }
    for (;;) {
      const state = await fullCheck(head, config, io, after);
      if (state === "failed") throw new Error("Полная проверка не удалась");
      if (state === "passed") break;
      if ((await io.api(`pulls/${number}`)).head.sha !== head) throw new Error("Во время проверки коммит изменился");
      await io.wait();
    }
    pr = await io.api(`pulls/${number}`);
    if (pr.head.sha !== head) throw new Error("Сливаемый коммит не проходил ревью в этом цикле");
    if (pr.base.ref !== "main")
      throw new Error("Во время ожидания проверок целевая ветка изменилась; разрешено слияние только в main");
    if (!pr.merged_at) {
      if (!labels(pr).has("deliver")) {
        await status(io, head, "delivery", "success", "Знак поставки отозван, не объединен и не опубликован.");
        return { summary: "Маркировка поставки снята." };
      }
      if (labels(pr).has("deliver-review")) return reviewOnly(pr);
      if ((await io.api("git/ref/heads/main")).object.sha !== base) {
        if (round < 3) continue;
        throw new Error("main Продвижение, повторная синхронизация и проверка позже");
      }
      await status(io, head, config.review.status, "success", "Ревью этого коммита и полный набор проверок пройдены");
      try {
        await io.merge(pr, config);
      } catch (error) {
        if (!(await io.api(`pulls/${number}`)).merged_at) throw error;
      }
      pr = await io.api(`pulls/${number}`);
      if (!pr.merged_at) throw new Error("Слияние пока не подтверждено; проверка продолжится позже");
    }
  }
  try {
    await waitLive(pr.merge_commit_sha, config, io);
    const summary = config.health
      ? "Объединено и успешно выпущено, работоспособная версия проверена."
      : "Уже объединены; у проекта нет онлайн-сервиса";
    await status(io, pr.head.sha, "delivery", "success", summary);
    await clearLabels(number, pr, io);
    return { summary, merged: pr.merge_commit_sha, findings: tooLate, head };
  } catch (error) {
    // The next round finds the PR merged and doesn't review, so what this one found has to leave with this failure.
    throw Object.assign(error as Error, { merged: pr.merge_commit_sha, findings: tooLate, head });
  }
}
