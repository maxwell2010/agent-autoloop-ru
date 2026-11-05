// rules.json: the sources that may send events, the agents that do the work, the channels that reach the owner, the
// rules between them and, only to be shown, the scheduled tasks that run elsewhere. A mistake is caught here with a
// message saying where: at start it stops the hub, later it leaves the old rules running and the owner is told.
import { nextRun, parseCron } from "../kernel/cron.ts";
import { SCHEDULE, type Rule, type Rules } from "../kernel/rules.ts";

export class RulesError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`rules.json Обнаружены проблемы:\n${issues.join("\n")}`);
    this.issues = issues;
  }
}

const ACCESS = ["read", "edit", "full"];
const TELLS = ["always", "needed", "never"];
const ID = /^[a-z][a-z0-9-]*$/;
const TYPE_PATTERN = /^(\*|[a-z][a-z0-9_.-]{0,63}(\.\*)?)$/;
const ASK_FIRST = [
  "Удаление данных",
  "Остановка сервиса",
  "расходы",
  "Отправка сообщений во внешний мир",
  "менять направление продукта",
  "Создать или обновить ключ",
  "Изменение полномочий",
];
const NOT_EMPTY = "Не может быть пустым";
const ID_WORDS = "Только строчные буквы, цифры и -";

type Check = (value: unknown) => boolean;
type Field = [name: string, check: Check, problem: string, optional?: boolean];

const isText: Check = (value) => typeof value === "string" && value.trim() !== "";
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isWords: Check = (value) => Array.isArray(value) && value.every(isText);
const isSomeWords: Check = (value) => isWords(value) && (value as string[]).length > 0;
const isId: Check = (value) => typeof value === "string" && ID.test(value);
const isCount: Check = (value) => Number.isInteger(value) && (value as number) > 0;
const isTypes: Check = (value) => isSomeWords(value) && (value as string[]).every((type) => TYPE_PATTERN.test(type));
const isCron: Check = (value) => typeof value === "string" && parseCron(value) !== null;

function isKeyOf(table: object): Check {
  return (value) => typeof value === "string" && value in table;
}

function isZone(zone: unknown) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone as string });
    return isText(zone);
  } catch {
    return false;
  }
}

/** Each field present and well formed, and no others: a misspelt field would otherwise be silently ignored. */
function checkFields(issues: string[], where: string, value: unknown, spec: Field[]) {
  if (!isObject(value)) return void issues.push(`${where.trim()}: должно быть объектом`);
  for (const [name, check, problem, optional] of spec) {
    if (!(name in value)) {
      if (!optional) issues.push(`${where.trim()}: отсутствует ${name}`);
    } else if (!check(value[name])) issues.push(`${where.trim()}: поле ${name} ${problem}`);
  }
  for (const name of Object.keys(value)) {
    if (!spec.some(([known]) => known === name)) issues.push(`${where.trim()}: содержит неизвестное поле ${name}`);
  }
}

const nameOf = (entry: unknown) => (isObject(entry) && typeof entry.name === "string" ? entry.name : "");

function checkRule(issues: string[], rules: Rules, rule: Rule, names: Set<string>, now: number) {
  const name = nameOf(rule);
  if (names.has(name)) issues.push(`Имя правила «${name}» повторяется`);
  names.add(name);
  const where = `Правило «${name}»`;
  const when = isObject(rule) ? rule.when : undefined;
  checkFields(issues, where, rule, [
    ["name", isText, NOT_EMPTY],
    ["when", isObject, "должно быть объектом"],
    ["to", isKeyOf(rules.agents), `Не зарегистрирован Agent:${isObject(rule) ? rule.to : ""}`],
    [
      "cwd",
      (value) => typeof value === "string" && /^(~\/|\/)/.test(value),
      "должно быть путем, начинающимся с ~/ или /",
    ],
    ["skill", isText, NOT_EMPTY, true],
    ["prompt", isText, NOT_EMPTY, true],
    ["group", isText, NOT_EMPTY, true],
    ["parallel", isCount, "должно быть положительным целым числом", true],
    ["resume", (value) => typeof value === "boolean", "Это может быть только true или false", true],
    ["tell", (value) => TELLS.includes(value as string), `Это может быть только ${TELLS.join(", ")}`, true],
    ["emits", isObject, "должно быть объектом", true],
  ]);
  if (isObject(when) && "source" in when) {
    checkFields(issues, `${where.trim()}: поле when `, when, [
      ["source", isKeyOf(rules.sources), `Незарегистрированный источник:${when.source}`],
      ["types", isTypes, "должно быть списком типов событий; допускается x.* или *"],
    ]);
  } else if (isObject(when)) {
    if (isCron(when.cron) && nextRun(parseCron(when.cron as string)!, now, rules.timezone) === null) {
      issues.push(`${where}расписание никогда не наступит:${when.cron}`);
    }
    checkFields(issues, `${where.trim()}: поле when `, when, [["cron", isCron, "некорректное cron-выражение"]]);
  }
  if (!isObject(rule)) return;
  // A plain command needs no words: a script that polls something is an agent too.
  if (!rule.skill && !rule.prompt && rules.agents[rule.to]?.use !== "command") {
    issues.push(`${where.trim()}: поле skill и prompt Укажите хотя бы один`);
  }
  // Here and not on the agent: only a rule makes it run, and one no rule uses has always been allowed to be unfinished.
  const agent = rules.agents[rule.to];
  if (agent?.use === "acp" && !agent.command) issues.push(`${where}используется Agent ${rule.to} Отсутствует command`);
  if (isObject(rule.emits)) {
    const emittable: Check = (value) => value !== SCHEDULE && isKeyOf(rules.sources)(value);
    checkFields(issues, `${where.trim()}: поле emits `, rule.emits, [
      ["source", emittable, `Незарегистрированный источник:${rule.emits.source}`],
      ["types", isTypes, "должно быть списком типов событий"],
    ]);
  }
  rule.group ??= rule.name;
  rule.tell ??= "needed";
}

export function parseRules(json: string, now: number, timezone: string): Rules {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new RulesError([`Некорректный JSON:${(error as Error).message}`]);
  }
  const issues: string[] = [];
  checkFields(issues, "rules.json ", parsed, [
    ["timezone", isZone, "Неправильный часовой пояс.", true],
    ["askFirst", isWords, "должно быть списком строк", true],
    ["sources", isObject, "должно быть объектом"],
    ["agents", isObject, "должно быть объектом"],
    ["channels", isObject, "должно быть объектом", true],
    ["rules", Array.isArray, "должно быть списком"],
    ["elsewhere", Array.isArray, "должно быть списком", true],
  ]);
  if (issues.length) throw new RulesError(issues);
  const rules = parsed as Rules;
  rules.timezone ??= timezone;
  rules.askFirst ??= ASK_FIRST;
  rules.channels ??= {};
  rules.elsewhere ??= [];
  if (SCHEDULE in rules.sources)
    issues.push(`источник ${SCHEDULE} зарезервировано; для расписания используется правило cron`);
  for (const [id, source] of Object.entries(rules.sources)) {
    if (!ID.test(id)) issues.push(`ID источника${ID_WORDS}:${id}`);
    checkFields(issues, `источник ${id} `, source, [
      ["name", isText, NOT_EMPTY],
      ["adapter", isText, NOT_EMPTY, true],
    ]);
  }
  rules.sources[SCHEDULE] = { name: "Расписание" };
  for (const [id, channel] of Object.entries(rules.channels)) {
    if (!ID.test(id)) issues.push(`ID канала${ID_WORDS}:${id}`);
    checkFields(issues, `канал ${id} `, channel, [
      ["name", isText, NOT_EMPTY],
      ["answerers", isWords, "должно быть списком строк", true],
      ["links", (value) => typeof value === "boolean", "должно быть true или false", true],
    ]);
  }
  for (const [id, agent] of Object.entries(rules.agents)) {
    if (!ID.test(id)) issues.push(`Agent номер${ID_WORDS}:${id}`);
    checkFields(issues, `Agent ${id} `, agent, [
      ["name", isText, NOT_EMPTY],
      ["worker", isId, ID_WORDS],
      ["use", isId, ID_WORDS],
      ["model", isText, NOT_EMPTY, true],
      ["effort", isText, NOT_EMPTY, true],
      ["access", (value) => ACCESS.includes(value as string), `Это может быть только ${ACCESS.join(", ")}`, true],
      [
        "command",
        isSomeWords,
        "должно быть массивом аргументов командной строки",
        !isObject(agent) || agent.use !== "command",
      ],
      ["timeout", isCount, "должно быть положительным целым числом минут", true],
    ]);
    if (isObject(agent)) agent.access ??= "edit";
  }
  const names = new Set<string>();
  for (const rule of rules.rules) checkRule(issues, rules, rule, names, now);
  if (issues.length) throw new RulesError(issues);
  const limits = new Map<string, number | undefined>();
  for (const { group, parallel } of rules.rules) {
    if (limits.has(group) && limits.get(group) !== parallel)
      issues.push(`Группа «${group}»правила из parallel должны совпадать`);
    limits.set(group, parallel);
  }
  for (const task of rules.elsewhere) {
    const name = nameOf(task);
    if (names.has(name)) issues.push(`Запланированная задача «${name}»: имя повторяется в правиле или другом задании.`);
    names.add(name);
    checkFields(issues, `Запланированная задача «${name}»`, task, [
      ["name", isText, NOT_EMPTY],
      ["source", isKeyOf(rules.sources), "Не зарегистрированный источник"],
      ["to", isKeyOf(rules.agents), "Не зарегистрирован Agent"],
      ["cron", isCron, "некорректное cron-выражение"],
      ["where", isText, NOT_EMPTY],
    ]);
  }
  if (issues.length) throw new RulesError(issues);
  return rules;
}
