// One run's timeline, told from the facts in the log: what set it off, who took it, what it asked and what came of it.
import type { Fact, Row } from "../kernel/evolve.ts";

function time(value: string | number) {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
const eventText = (event: Row) => `источник ${event.source} · тип ${event.type} · объект ${event.subject || "нет"}`;

export function formatWhy(id: number, facts: Fact[]) {
  const allChanges = facts.flatMap((fact) => fact.changes);
  const relations = new Map<string, Row>();
  for (const { table, key, row } of allChanges) {
    if (table !== "run_events") continue;
    if (row) relations.set(key, row);
    else relations.delete(key);
  }
  const ownRelations = [...relations.values()].filter((relation) => relation.run_id === id);
  const events = new Set(ownRelations.map((relation) => relation.event_id));
  const runs = allChanges.filter(({ table, row }) => table === "runs" && row?.id === id).map(({ row }) => row!);
  const links = new Map<number, string>();
  for (const run of runs) if (run.issued && run.link) links.set(run.issued, run.link);
  const versions = new Set(runs.map((run) => run.rules_version));
  const rulesAt = new Map<number, any>();
  for (const fact of facts) {
    if (fact.type !== "rules") continue;
    const config = fact.changes.find(({ table, key }) => table === "config" && key === "rules");
    rulesAt.set(fact.seq, config!.row!.value);
  }
  const lines = [`номер ${id} цикл. · ${runs.at(-1)!.rule}`];
  const add = (at: string | number, text: string) => lines.push(`${time(at)}  ${text}`);
  const previous = new Map<string, Row>();
  const started = new Set<number>();

  function tellRun(fact: Fact, row: Row, before: Row | undefined, receipt: boolean) {
    if (row.claimed_at && row.claimed_at !== before?.claimed_at) {
      const agent = rulesAt.get(row.rules_version).agents[row.agent];
      add(row.claimed_at, `${agent.worker} Получено (${agent.name})`);
    }
    if (fact.type === "started" && !started.has(row.issued)) {
      add(fact.at, "Начало обработки");
      started.add(row.issued);
    }
    if (row.link && row.link === links.get(row.issued) && row.link !== before?.link)
      add(fact.at, `Разговор:${row.link}`);
    if (row.finished_at && row.finished_at !== before?.finished_at) {
      add(
        row.finished_at,
        `Завершено:${row.summary || (row.state === "cancelled" ? "Остановлено" : "Итог не указан")}`,
      );
    }
    if (receipt && row.state === "queued" && row.attempts !== before?.attempts) {
      add(fact.at, `Цикл не завершен:${row.error};Время повтора ${time(row.not_before)}`);
    }
    if (receipt)
      for (const rejected of JSON.parse(row.last_answer ?? "[]")) add(fact.at, `Не выполнено:${rejected.reason}`);
  }

  function tellCard(row: Row, before: Row | undefined, receipt: boolean) {
    const own = row.run_id === id;
    if (!before && own && (!row.fyi || row.key.startsWith("thread:"))) {
      const options = JSON.parse(row.options) as string[];
      add(row.created_at, `${row.kind === "ask" ? "Вопрос" : "Уведомление"}:${row.title}`);
      if (row.text)
        lines.push(
          ...String(row.text)
            .split("\n")
            .map((line) => `                ${line}`),
        );
      if (options.length) lines.push(`                Варианты:${options.join(" / ")}`);
    }
    if (row.decided_at && row.decided_at !== before?.decided_at && (own || events.has(row.answer_event))) {
      const answer = row.answer ?? JSON.parse(row.options)[row.choice];
      add(row.decided_at, `${row.by || "владелец"}Ответ «${row.title}»:${answer}`);
      if (own) {
        const next = [...relations.values()].filter(
          (relation) => relation.event_id === row.answer_event && relation.run_id !== id,
        );
        for (const { run_id } of next) add(row.decided_at, `Продолжение после ответа: цикл ${run_id} цикл.`);
      }
    }
    if (row.state === "closed" && before?.state !== "closed" && (receipt || own) && !row.fyi) {
      add(row.closed_at, `Закрыто:${row.title};${row.result}`);
    }
  }

  for (const fact of facts) {
    if (fact.type === "rules" && versions.has(fact.seq)) add(fact.at, `Версия правил #${fact.seq}`);
    const changes = new Map(fact.changes.map((change) => [`${change.table}:${change.key}`, change]));
    const receipt = fact.type === "finish" && Boolean(changes.get(`runs:${id}`)?.row);
    for (const [changed, { table, key, row }] of changes) {
      const before = previous.get(changed);
      if (table === "events" && row && !before && events.has(row.id)) {
        add(row.received_at, `События запуска:${eventText(row)}`);
      }
      if (table === "runs" && row?.id === id) tellRun(fact, row, before, receipt);
      if (table === "cards" && row) tellCard(row, before, receipt);
      if (receipt && table === "timers") {
        add(
          fact.at,
          row ? `Назначена проверка: ${row.about};время ${time(row.at)}` : `Отменена проверка: ${before?.key ?? key}`,
        );
      }
      if (receipt && table === "events" && row && !before && !events.has(row.id)) {
        add(fact.at, `Событие выпуска:${eventText(row)}`);
      }
      if (row) previous.set(changed, row);
      else previous.delete(changed);
    }
  }
  return lines.join("\n");
}
