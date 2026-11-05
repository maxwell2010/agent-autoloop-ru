import assert from "node:assert/strict";
import { deadlines } from "../kernel/due.ts";
import { snapshot, type Fact, type View, type Row } from "../kernel/evolve.ts";

type Snapshot = ReturnType<typeof snapshot>;
const rows = (view: Snapshot, table: keyof Snapshot["tables"]) => Object.values(view.tables[table]);
// Independent replay oracle: it checks the indexed projection without using its write or query implementation.
export function replay(log: Fact[]): Snapshot {
  const tables = Object.fromEntries(
    ["events", "runs", "run_events", "cards", "deliveries", "timers", "schedules", "seen", "keys", "config", "due"].map(
      (t) => [t, {}],
    ),
  ) as Snapshot["tables"];
  const next: Record<string, number> = {};
  let seq = 0;
  for (const fact of log) {
    seq = fact.seq;
    for (const { table, key, row } of fact.changes) {
      if (row === null) delete tables[table][key];
      else {
        tables[table][key] = row;
        // Configuration versions are derived from each rules fact, including logs written before the lookup existed.
        if (table === "config" && key === "rules") tables.config[String(row.version)] = row;
        if (typeof row.id === "number") next[table] = Math.max(next[table] ?? 0, row.id);
      }
    }
  }
  return { seq, tables, next };
}
export function invariants(current: View, log: Fact[], before?: Snapshot) {
  const view = snapshot(current);
  assert.deepEqual(view, replay(log), "Повтор журнала дал другое состояние");
  for (const [index, fact] of log.entries())
    assert.equal(fact.seq, index + 1, "журналномер вариантанарушена последовательность");
  const events = rows(view, "events");
  const runs = rows(view, "runs");
  const cards = rows(view, "cards");
  const links = rows(view, "run_events");
  assert.equal(new Set(events.map((e) => JSON.stringify([e.source, e.key]))).size, events.length, "Повторное событие");
  const held = runs.filter((r) => r.state === "claimed");
  assert.equal(
    new Set(held.map((r) => JSON.stringify([r.grp, r.lane]))).size,
    held.length,
    "Одно и то же дело рассматривалось в двух инстанциях одновременно",
  );
  for (const group of new Set(held.map((r) => r.grp)))
    assert.ok(
      held.filter((r) => r.grp === group).length <=
        (view.tables.config.rules.value.rules.find((r: Row) => r.group === group)?.parallel ?? 1),
      "Превышена параллельность группы",
    );
  for (const e of events)
    for (const rule of JSON.parse(e.routed))
      assert.ok(
        links.some((l) => l.event_id === e.id && view.tables.runs[l.run_id]?.rule === rule),
        "Полученное событие утратило свою связь распределения.",
      );
  for (const card of cards)
    if (card.answer_event !== null) {
      const event = view.tables.events[card.answer_event];
      assert.equal(event?.type, "card.answered");
      if (view.tables.config.rules.value.rules.some((r: Row) => r.name === card.rule))
        assert.ok(
          links.some(
            (l) =>
              l.event_id === card.answer_event &&
              view.tables.runs[l.run_id]?.rule === card.rule &&
              view.tables.runs[l.run_id]?.lane === card.lane,
          ),
          "Ответ не разбудил первоначальный вопрос",
        );
    }
  if (before) {
    for (const e of rows(before, "events"))
      assert.deepEqual(view.tables.events[e.id], e, "Размещенное событие было изменено или потеряно");
    for (const c of rows(before, "cards"))
      if (c.answer_event !== null) {
        const now = view.tables.cards[c.id];
        assert.equal(now.answer_event, c.answer_event);
        assert.equal(now.choice, c.choice);
        assert.equal(now.answer, c.answer);
      }
    for (const r of rows(before, "runs"))
      if (["done", "nothing", "cancelled"].includes(r.state))
        assert.deepEqual(view.tables.runs[r.id], r, "Завершенная структурированный результат снова вступает в силу.");
  }
  if (log.length)
    assert.deepEqual(
      view.tables.due,
      deadlines(current, log.at(-1)!.at),
      "Таблица сроков годности отличается от пересчитанной",
    );
  return view;
}
