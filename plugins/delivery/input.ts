// What the delivery reads from the hub's context and hands back to it: which item an event means, and the receipt.
import type { Delivered } from "./delivery.ts";

export function subjectNumber<E extends { subject: string }>(repo: string, context: { events: E[] }) {
  const subjects = [...new Set(context.events.map((event) => event.subject))];
  const suffix = subjects[0]?.slice(repo.length + 1);
  if (subjects.length !== 1 || !subjects[0].startsWith(`${repo}#`) || !/^[1-9]\d*$/.test(suffix)) {
    throw new Error("Событие не указывает на одно и то же вещество на репозитории, указанном правилом");
  }
  const number = Number(suffix);
  if (!Number.isSafeInteger(number)) throw new Error("Номер позиции неверен.");
  return number;
}

export function question(issue: { number: number; title: string; body?: string; html_url: string }) {
  const lines = (issue.body ?? "").replace(/```[\s\S]*?```/g, "").split("\n");
  const text = lines
    .filter((line) => !/\/Users\/|\/home\/|Traceback|^\s+at /.test(line))
    .join("\n")
    .trim();
  return {
    key: `owner-${issue.number}`,
    title: [...issue.title].slice(0, 100).join(""),
    text: [...(text || issue.html_url)].slice(0, 1500).join(""),
    options: ["Обработано", "Пока не обрабатывать"],
    about: issue.html_url,
  };
}

/** The hub reads a receipt up to the first three backticks, even inside a string, so what people wrote can't spell them. */
export const receiptBlock = (receipt: object) =>
  `\`\`\`agent-autoloop\n${JSON.stringify(receipt).replaceAll("`", "\\u0060")}\n\`\`\``;

export function deliveryReceipt(number: number, result: Delivered, attended: boolean) {
  if (!result.findings?.length) return result.summary;
  const text = result.findings.map((finding) => `${finding.title}:${finding.text}`).join("\n");
  // Left as written, a finding could hold a receipt block of its own, and the hub would act on it.
  if (attended) return `${result.summary}\n${text.replaceAll("```", "'''")}`;
  // An open card with the same key takes the new one in, so findings on a new commit need a key of their own.
  const key = `review-${number}-${result.head?.slice(0, 12)}`;
  const title = result.merged
    ? "При проверке объединенных изменений обнаружены проблемы"
    : "Проблемы необходимо устранить до поставки.";
  const notice = { key, title, text: [...text].slice(0, 1500).join("") };
  return `${result.summary}\n${receiptBlock({ notice: [notice] })}`;
}

/** A failed round with findings to hand on: the first line tells the hub to retry, and only that line is the error. */
export function failedReceipt(number: number, failure: Error & Partial<Delivered>, attended: boolean) {
  const why = failure.message.split("\n")[0].replaceAll("```", "'''");
  const { findings, head, merged } = failure;
  return deliveryReceipt(number, { summary: `FAILED:${why}`, findings, head, merged }, attended);
}

export function pendingEvents(
  repo: string,
  rows: { number: number; head: string; labelEvent: number; kind: string }[],
) {
  return rows.map(({ number, head, labelEvent, kind }) => ({
    id: `${repo}#${number}:${labelEvent}:${head}`,
    type: `${kind}.labeled`,
    subject: `${repo}#${number}`,
    link: `https://github.com/${repo}/${kind === "pull_request" ? "pull" : "issues"}/${number}`,
  }));
}
