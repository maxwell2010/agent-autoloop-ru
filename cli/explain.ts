// `rules explain` and `emit --dry-run`: what this machine's rules file says, without asking a hub or writing a fact.
import { describeCron, nextRun, parseCron } from "../kernel/cron.ts";
import { cronOf, eventRule, typeMatches, type Rule, type Rules } from "../kernel/rules.ts";
import { parseRules } from "../protocol/rules.ts";
import { parseEvent } from "../protocol/validate.ts";

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const clock = (zone: string) =>
  ({ timeZone: zone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) as const;
const when = (rule: Rule, rules: Rules, now: number) =>
  eventRule(rule)
    ? `источник ${rule.when.source} · ${rule.when.types.join(", ")}`
    : `Выбор времени ${describeCron(cronOf(rule))}(В следующий раз ${new Date(
        nextRun(parseCron(cronOf(rule))!, now, rules.timezone)!,
      ).toLocaleString("ru-RU", clock(rules.timezone))})`;

function details(rule: Rule, rules: Rules, now: number) {
  const parts = [when(rule, rules, now), `→ ${rule.to}`, rule.cwd];
  if (rule.parallel) parts.push(`Параллелизм ${rule.parallel}`);
  if (rule.resume) parts.push("продолжить сессию прошлого цикла");
  if (rule.group !== rule.name) parts.push(`группа ${rule.group}`);
  if (rule.tell !== "needed") parts.push(`Уведомление ${rule.tell}`);
  if (rule.skill) parts.push("есть Skill");
  if (rule.prompt) parts.push("есть Prompt");
  if (rule.emits) parts.push(`Можно отправить ${rule.emits.source} ${rule.emits.types.join(", ")}`);
  return parts.join(" · ");
}

/** The rules as this machine would run them, one line per thing an owner asks about. */
export function explainRules(text: string, now = Date.now(), zone = localZone()): string[] {
  const rules = parseRules(text, now, zone);
  const lines = [
    `часовой пояс ${rules.timezone};Сначала позвольте мне спросить вас:${rules.askFirst.join(", ")};${rules.rules.length} правил`,
    `Источник:${Object.entries(rules.sources)
      .map(([id, source]) => `${id}(${source.name})`)
      .join(", ")}`,
    `Agent:${Object.entries(rules.agents)
      .map(([id, agent]) => `${id}(${agent.name}, ${agent.worker}, права ${agent.access})`)
      .join(", ")}`,
  ];
  if (Object.keys(rules.channels).length)
    lines.push(
      `Каналы:${Object.entries(rules.channels)
        .map(([id, channel]) => {
          const answerers = channel.answerers?.length ? `, Ответчик ${channel.answerers.join(", ")}` : "";
          return `${id}(${channel.name}${answerers}${channel.links ? ", Со ссылкой" : ""})`;
        })
        .join(", ")}`,
    );
  lines.push("Правила:");
  for (const rule of rules.rules) lines.push(`  ${rule.name}:${details(rule, rules, now)}`);
  for (const task of rules.elsewhere)
    lines.push(`  ${task.name}:В другом месте (${task.where})${describeCron(task.cron)}`);
  return lines;
}

/** What a source event would be handed to, by the rules file alone: no hub, no log, no key. */
export function previewEvent(
  text: string,
  source: string,
  event: unknown,
  now = Date.now(),
  zone = localZone(),
): string[] {
  const rules = parseRules(text, now, zone);
  const parsed = parseEvent(event);
  const lines = [`Событие:${source} ${parsed.type}${parsed.subject ? ` ${parsed.subject}` : ""}`];
  if (!rules.sources[source]) lines.push(`источник ${source} не зарегистрировано в rules.json для sources внутри`);
  const matched = rules.rules.filter(
    (rule) => eventRule(rule) && rule.when.source === source && typeMatches(rule.when.types, parsed.type),
  );
  if (!matched.length) {
    lines.push("Для события нет правила; при отправке оно будет записано как событие без назначения.");
    return lines;
  }
  lines.push("Будет назначено:");
  for (const rule of matched) lines.push(`  ${rule.name} → ${rule.to} · ${rule.cwd}`);
  return lines;
}
