// One delivery run: `node run.ts owner/name`, reading its event from AGENT_AUTOLOOP_CONTEXT and printing a receipt.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIO } from "./github.ts";
import { deliver, disableAuto, status, type Delivered } from "./delivery.ts";
import { deliveryReceipt, failedReceipt, question, receiptBlock, subjectNumber } from "./input.ts";

const hasLabel = (issue: any, name: string) => issue.labels.some((label: any) => label.name === name);

export async function run(repo: string, context: any, testLocalHealth = false) {
  const number = subjectNumber(repo, context);
  const folder = mkdtempSync(join(tmpdir(), "agent-autoloop-delivery-"));
  const io = createIO(repo, folder);
  try {
    const issue = await io.api(`issues/${number}`);
    if (!issue.pull_request) {
      if (issue.state !== "open" || !hasLabel(issue, "ask-owner")) return "NOTHING: Нет вопросов, требующих обработки";
      if (context.answers?.length) {
        await io.api(`issues/${number}/labels/ask-owner`, undefined, "DELETE");
        return "Записанные результаты обработки";
      }
      return `Требуется ваше действие\n${receiptBlock({ ask: [question(issue)] })}`;
    }
    const attended = hasLabel(issue, "deliver-attended");
    try {
      const result = await deliver(repo, number, io, testLocalHealth);
      return deliveryReceipt(number, result, attended);
    } catch (error) {
      const failure = error as Error & Partial<Delivered>;
      const receipt = failure.findings?.length ? failedReceipt(number, failure, attended) : "";
      try {
        const pr = await io.api(`pulls/${number}`);
        if (pr.auto_merge) await disableAuto(number, io);
        await status(io, pr.head.sha, "delivery", "failure", failure.message);
      } catch (other) {
        // The next round won't review, so the findings go out whatever GitHub says now.
        if (!receipt) throw other;
      }
      if (receipt) return receipt;
      throw error;
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [repo, ...args] = process.argv.slice(2);
  const context = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT!, "utf8"));
  run(repo, context, args.includes("--test-local-health"))
    .then((text) => console.log(text))
    .catch((error) => {
      console.error((error as Error).message);
      process.exitCode = 1;
    });
}
