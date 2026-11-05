// The command line: what a person, or their Agent, types.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { hubClient } from "../protocol/client.ts";
import { CONFIG_FILE, readConfig, writeConfig, type Config } from "../host/config.ts";
import { HOME, RULES_FILE } from "../host/home.ts";
import { installService, removeService, restartService, serviceRunning, systemUnit } from "../host/service.ts";
import { versionLine } from "../host/version.ts";
import { spendLine } from "./spend.ts";
import { attemptsOf, newFailure, waitingRetry } from "./try.ts";

const ROOT = path.join(import.meta.dirname, "..");
const PROGRAM = path.join(ROOT, "bin", "agent-autoloop.ts");

const HELP = `Agent Autoloop - сервис автоматизации

  agent-autoloop init [--agent claude|codex] [--command 'команда {prompt}'] [--port 3350] [--no-service]
      Настроить сервис и исполнителя на этом компьютере
  agent-autoloop try
      Проверить полный цикл с вашим агентом: вопрос, ответ и продолжение
  agent-autoloop why <цикл> [--json]
      Показать хронологию цикла; --json выводит исходные факты
  agent-autoloop conformance <адрес> --config <файл-ключей>
      Проверить протокол на тестовом сервисе
  agent-autoloop status [--json]
      Показать подключения, карточки, работу и расходы; --json выводит /v1/state
  agent-autoloop answer <карточка> [вариант] [--text текст]
      Ответить на вопрос; для уведомления номер варианта не требуется
  agent-autoloop resolve <карточка> <итог>
      Закрыть карточку с пояснением
  agent-autoloop doctor                  Проверить настройку
  agent-autoloop check                   Проверить rules.json
  agent-autoloop rules explain           Показать правила, агентов, каналы и следующие запуски
  agent-autoloop emit <тип> [--dry-run] [--subject x] [--summary x] [--detail x] [--link x] [--id x] [--key ключ]
      Отправить событие; --dry-run показывает назначение без обращения к сервису
  agent-autoloop tell <номер> [--task имя]
      Отправить уведомление; текст читается из стандартного ввода
  agent-autoloop stop <цикл>              Остановить цикл
  agent-autoloop key new <source|worker|channel|owner> <имя>
      Создать ключ; он показывается только один раз
  agent-autoloop key list                Показать ключи
  agent-autoloop key remove <тип> <имя>   Немедленно отозвать ключ
  agent-autoloop add <git-адрес>          Установить плагин без автоматического обновления
  agent-autoloop mcp                     Подключить MCP-клиент через stdin/stdout
  agent-autoloop join <адрес> --worker <имя> --key <ключ> [--no-service]
      Подключить этот компьютер как исполнителя другого сервиса
  agent-autoloop backup [каталог]
      Скопировать базу, главный ключ, конфигурацию, правила и secrets.env
      По умолчанию: ~/.agent-autoloop/backups
  agent-autoloop restore <каталог> [--yes]
      Восстановить данные после остановки сервиса; --yes пропускает подтверждение
  agent-autoloop update                  Обновить программу
  agent-autoloop uninstall [--yes]       Удалить программу, сохранив данные
  agent-autoloop --version               Показать версию и текущий коммит
  agent-autoloop help                    Показать эту справку
  agent-autoloop up                      Запустить сервис
  agent-autoloop service install|remove  Установить или удалить системную службу

Конфигурация и данные: ${HOME}. Правила: ${RULES_FILE}.
Изменения правил применяются автоматически.`;

const INIT_USAGE = `Использование: agent-autoloop init [--agent claude|codex] [--command 'команда {prompt}'] [--port 3350] [--no-service]

  --agent      Использовать только claude или codex; по умолчанию подключаются все найденные
  --command    Использовать другой CLI-агент; {prompt} передается отдельным аргументом
  --port       Порт сервиса, по умолчанию 3350
  --no-service Не устанавливать службу; затем запустить agent-autoloop up вручную`;

const TRY_USAGE = `Использование: agent-autoloop try

Проверить полный цикл с локальным агентом: вопрос, завершение процесса на время ожидания, ваш ответ и продолжение работы.`;

const STATUS_USAGE = `Использование: agent-autoloop status [--json]

Показать подключения, ожидающие решения, текущую и завершенную работу и расходы.
  --json  Исходная структура /v1/state для скриптов и панелей`;

const UPDATE_USAGE = `Использование: agent-autoloop update

Обновить программу. Параметры не требуются.`;

const UNINSTALL_USAGE = `Использование: agent-autoloop uninstall [--yes]

Удалить программу, сохранив правила, ключи и журнал.
  --yes  Пропустить подтверждение`;

const RESTORE_USAGE = `Использование: agent-autoloop restore <каталог> [--yes]

Восстановление заменяет базу данных, главный ключ, конфигурацию, правила и secrets.env.
Сначала остановите сервис. --yes пропускает подтверждение.`;

/** What each command reads besides its own words, and how to use it. */
const TAKES: Record<string, { flags: string[]; usage: string }> = {
  add: { flags: [], usage: "Использование: agent-autoloop add <git адрес>" },
  answer: {
    flags: ["text"],
    usage: "Использование: agent-autoloop answer <карточка> [номер варианта] [--text Другой ответ]",
  },
  backup: { flags: [], usage: "Использование: agent-autoloop backup [каталог]" },
  check: { flags: [], usage: "Использование: agent-autoloop check" },
  conformance: {
    flags: ["config"],
    usage: "Использование: agent-autoloop conformance <адрес тестового сервиса> --config <файл тестовых ключей>",
  },
  doctor: { flags: [], usage: "Использование: agent-autoloop doctor" },
  emit: {
    flags: ["dry-run", "subject", "summary", "detail", "link", "id", "key"],
    usage:
      "Использование: agent-autoloop emit <тип> [--dry-run] [--subject x] [--summary x] [--detail x] [--link x] [--id x] [--key ключ источника]",
  },
  init: { flags: ["agent", "command", "port", "no-service"], usage: INIT_USAGE },
  join: {
    flags: ["worker", "key", "no-service"],
    usage: "Использование: agent-autoloop join <Адрес центра> --worker <имя> --key <ключ> [--no-service]",
  },
  key: {
    flags: [],
    usage: `Использование: agent-autoloop key new <source|worker|channel|owner> <имя>
      agent-autoloop key list
      agent-autoloop key remove <тип> <имя>`,
  },
  mcp: { flags: [], usage: "Использование: agent-autoloop mcp" },
  // Only its first word is read as anything: the rest is a result in someone's own words, dashes and all.
  resolve: { flags: [], usage: "Использование: agent-autoloop resolve <карточка> <результат>" },
  restore: { flags: ["yes"], usage: RESTORE_USAGE },
  rules: { flags: [], usage: "Использование: agent-autoloop rules explain" },
  service: { flags: [], usage: "Использование: agent-autoloop service install|remove" },
  status: { flags: ["json"], usage: STATUS_USAGE },
  stop: { flags: [], usage: "Использование: agent-autoloop stop <номер цикла>" },
  tell: {
    flags: ["task"],
    usage:
      "Использование: agent-autoloop tell <номер> [--task имя задания], Контент считывается со стандартного ввода.",
  },
  try: { flags: [], usage: TRY_USAGE },
  uninstall: { flags: ["yes"], usage: UNINSTALL_USAGE },
  up: { flags: [], usage: "Использование: agent-autoloop up" },
  update: { flags: [], usage: UPDATE_USAGE },
  why: { flags: ["json"], usage: "Использование: agent-autoloop why <номер цикла> [--json]" },
};

type Flags = Record<string, string | true>;

function flags(args: string[]) {
  const named: Flags = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) {
      rest.push(args[i]);
      continue;
    }
    const name = args[i].slice(2);
    if (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) named[name] = args[++i];
    else named[name] = true;
  }
  return { named, rest };
}
const text = (value: string | true | undefined) => (typeof value === "string" ? value : undefined);
const fail = (words: string): never => {
  console.error(words);
  process.exit(1);
};

/**
 * Stops at a flag the command doesn't read. A misspelt --port would otherwise install with the default in silence, and
 * --help would install at all.
 */
function refuseUnknownFlags(args: string[], { flags: known, usage }: { flags: string[]; usage: string }) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    process.exit(0);
  }
  const unknown = Object.keys(flags(args).named).filter((name) => !known.includes(name));
  if (unknown.length) fail(`Неизвестные параметры:${unknown.map((name) => `--${name}`).join(", ")}\n\n${usage}`);
}

const client = (key: string, config = readConfig()) => hubClient(config.url, key);
const ownerClient = (config = readConfig()) =>
  client(
    config.owner ??
      fail("На этом компьютере нет ключа владельца; компьютеру только с исполнителем просмотр недоступен"),
    config,
  );

/** The first rules of a new install: its agents and one rule to try the whole loop with. */
function starterRules(agents: Record<string, object>, first: string) {
  return {
    sources: { local: { name: "локальный компьютер" } },
    agents,
    channels: { desktop: { name: "Уведомления рабочего стола" } },
    rules: [
      {
        name: "Пробный запуск",
        when: { source: "local", types: ["try.*"] },
        to: first,
        cwd: path.join(HOME, "try"),
        prompt:
          "Это пробный запуск agent-autoloop try. Не изменяй файлы и не выполняй других действий. Прочитай файл данных. " +
          "Если answers пуст, задай вопрос: title «Пробный запуск: выберите цвет», text «Это проверка, подойдет любой вариант», " +
          'options ["Синий", "Зеленый"], key "try-color". Первая строка итога: «Задан вопрос». ' +
          "Если answers не пуст, напиши итог «Вы выбрали <вариант>, пробный запуск пройден», подставив выбранный вариант. Структурированный результат не добавляй.",
      },
    ],
    elsewhere: [],
  };
}

/** Shows the user's Agents how to set it up. Only for the install in its usual place, never over their own. */
function linkSkill() {
  if (process.env.AGENT_AUTOLOOP_HOME) return;
  for (const agent of [".claude", ".codex"]) {
    if (!existsSync(path.join(homedir(), agent))) continue;
    const link = path.join(homedir(), agent, "skills", "agent-autoloop");
    if (lstatSync(link, { throwIfNoEntry: false })) continue;
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(path.join(ROOT, "skills", "agent-autoloop"), link);
  }
}

/** What to type to run this program: its name if that's what a shell finds, otherwise where it is. */
function howToRun() {
  const found = spawnSync("/bin/sh", ["-c", "command -v agent-autoloop"], { encoding: "utf8" }).stdout.trim();
  if (found && realpathSync(found) === realpathSync(PROGRAM)) return "agent-autoloop";
  return /\s/.test(PROGRAM) ? `'${PROGRAM}'` : PROGRAM;
}

/** What was asked for on the command line, or whichever of the usual Agents is installed. */
async function agentsToUse(named: Flags, worker: string) {
  const agents: Record<string, { name: string; worker: string; use: string; command?: string[] }> = {};
  const command = text(named.command);
  if (command) {
    agents.agent = { name: "Agent", worker, use: "command", command: command.split(/\s+/) };
    return agents;
  }
  const wanted = text(named.agent);
  const { adapterFor } = await import("../worker/agents.ts");
  const emptyTurn = {
    prompt: "",
    session: "",
    resume: null,
    cwd: "",
    access: "edit",
    contextFile: "",
    folder: "",
  } as const;
  for (const name of ["claude", "codex"]) {
    if (wanted && wanted !== name) continue;
    const adapter = await adapterFor(name);
    try {
      // An adapter finds its program to build the command line, and throws if it's not there.
      adapter.command(emptyTurn);
      agents[name] = { name: name === "claude" ? "Claude Code" : "Codex", worker, use: name };
    } catch {}
  }
  return agents;
}

async function init(args: string[]) {
  const { named, rest } = flags(args);
  // `init -p 4000` would otherwise install on the default port in silence.
  if (rest.length) return fail(`Неизвестные параметры:${rest.join(" ")}\n\n${INIT_USAGE}`);
  if (existsSync(CONFIG_FILE)) return fail(`Уже установлено:${CONFIG_FILE}`);
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(HOME, "try"), { recursive: true });
  const hostName = hostname()
    .toLowerCase()
    .replace(/\.local$/, "");
  const worker = hostName.replace(/[^a-z0-9-]/g, "-").replace(/^[^a-z]+/, "") || "this-machine";
  const agents = await agentsToUse(named, worker);
  if (!Object.keys(agents).length) {
    return fail(
      "На этом компьютере не найдено Claude Code или Codex. Сначала установите и войдите в систему," +
        "Или используйте --command Укажите другие командные строки Agent, например --command 'hermes chat -Q -q {prompt}'",
    );
  }
  const port = text(named.port) ?? "3350";
  const url = `http://127.0.0.1:${port}`;
  const ownRules = !existsSync(RULES_FILE);
  if (ownRules) {
    writeFileSync(RULES_FILE, `${JSON.stringify(starterRules(agents, Object.keys(agents)[0]), null, 2)}\n`);
  }
  const { addKey } = await import("../host/runtime.ts");
  const config: Config = {
    url,
    hub: { listen: `127.0.0.1:${port}`, publicUrl: url },
    worker: { name: worker, key: addKey("worker", worker) },
    source: { name: "local", key: addKey("source", "local") },
    owner: addKey("owner", "owner"),
    // A channel only rules.json knows about, or only this file, would do nothing: it's on only if both are ours to write.
    ...(ownRules && { channels: { desktop: { key: addKey("channel", "desktop") } } }),
  };
  writeConfig(config);
  linkSkill();
  if (!named["no-service"]) installService();
  const names = Object.values(agents).map((agent) => agent.name);
  const reach = ownRules ? "  Канал: уведомления рабочего стола\n" : "";
  const run = howToRun();
  const next = named["no-service"]
    ? `Сначала выполните ${run} up, затем в другом терминале выполните ${run} try Выполнить полный цикл.`
    : `Выполните ${run} try Выполнить полный цикл.`;
  console.log(`Установка завершена.\n  Agent:${names.join(", ")}\n${reach}  Правила:${RULES_FILE}\n\n${next}`);
}

async function join(args: string[]) {
  const { named, rest } = flags(args);
  const [url] = rest;
  const name = text(named.worker);
  const key = text(named.key);
  if (!url || !name || !key) return fail(TAKES.join.usage);
  // Joining another hub must not silently replace this machine's existing hub, worker or owner keys.
  if (existsSync(CONFIG_FILE)) {
    return fail(
      `Уже настроено:${CONFIG_FILE}. Чтобы предотвратить перезапись существующих настроек, сделайте резервную копию и измените конфигурацию вручную.`,
    );
  }
  writeConfig({ url, worker: { name, key } });
  if (!named["no-service"]) installService();
  const next = named["no-service"] ? `Выполните ${howToRun()} up Старт.` : "";
  console.log(`Этот компьютер подключен как ${name} подключен как исполнитель.${next}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Card = { id: number; kind: string; title: string; text: string; options: string[]; recommend: number | null };

function showCard(card: Card) {
  console.log(`\n【${card.kind === "ask" ? "Требуется ваше решение" : "Требует внимания"}】#${card.id} ${card.title}`);
  if (card.text) console.log(card.text);
  if (card.kind !== "ask") return;
  card.options.forEach((option, index) => {
    console.log(`  ${index + 1}. ${option}${index === card.recommend ? "(рекомендуется)" : ""}`);
  });
}

const howToAnswer = (card: Card) =>
  card.kind === "ask"
    ? `Ответ:agent-autoloop answer ${card.id} <номер варианта>`
    : `Обработано:agent-autoloop answer ${card.id}`;

async function chooseAt(terminal: ReturnType<typeof createInterface>, card: Card) {
  for (;;) {
    const choice = Number(await terminal.question("\nНомер варианта?"));
    if (Number.isInteger(choice) && choice >= 1 && choice <= card.options.length) return choice - 1;
    console.log(`ввод 1 Прибытие ${card.options.length}. `);
  }
}

async function tryIt() {
  const config = readConfig();
  if (!config.source) return fail("На этом компьютере нет ключа источника.");
  const owner = ownerClient(config);
  const stamp = Date.now();
  // A hub that can't be reached is said just below, when the event doesn't go through.
  const before = await owner.state().catch(() => ({ runs: [] }));
  const attempts = attemptsOf(before.runs);
  await client(config.source.key, config)
    .event({ id: `try-${stamp}`, type: "try.start", subject: `#${stamp}` })
    .catch((error) =>
      fail(
        `Не удается подключиться к сервису (${error.message}):Сначала agent-autoloop up или agent-autoloop service install`,
      ),
    );
  const retrying = waitingRetry(before.runs);
  if (retrying) {
    const clock = { timeZone: before.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
    const time = new Date(retrying.notBefore).toLocaleString("ru-RU", clock);
    console.log(
      `В прошлый раз не удалось запустить (${retrying.error}), ${time} Автоматически повторит попытку, на этот раз событие будет обработано вместе.`,
    );
  } else console.log("Событие отправляется,Agent Начать работать...");
  let asked: number | null = null;
  for (let i = 0; i < 300; i++) {
    await sleep(1000);
    const state = await owner.state();
    const failed = newFailure(state.runs, attempts);
    if (failed) return fail(`Agent FAILED:${failed.error}\nВыполните agent-autoloop doctor Проверьте.`);
    if (asked === null) {
      // An agent asking the same thing again lands on the card already open, so this may be from before: it's the one.
      const card: Card | undefined = state.cards.find(
        (open: Card) =>
          open.kind === "ask" && ["Пробный запуск", "\u8bd5\u8dd1"].some((prefix) => open.title.startsWith(prefix)),
      );
      if (!card) continue;
      asked = card.id;
      console.log("\nAgent завершил цикл и задал вопрос. Сейчас процесс не работает и не расходует Token. ");
      showCard(card);
      if (!process.stdin.isTTY) {
        console.log(
          `${howToAnswer(card)}\nПосле ответа выполните agent-autoloop status, чтобы увидеть продолжение и завершение работы.`,
        );
        return;
      }
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      const choice = await chooseAt(terminal, card);
      terminal.close();
      await owner.answer(card.id, { choice });
      console.log("Получено,Agent Продолжение работы...");
      continue;
    }
    const done = state.recentCards.find(
      (card: { id: number; state: string }) => card.id === asked && card.state === "done",
    );
    if (done) {
      console.log(
        `Это завершило работу:${done.result}\n\nПодключение работает. Теперь добавьте ${RULES_FILE} Замените своими правилами или настройте с вашим Agent Укажите кратко.`,
      );
      return;
    }
  }
  fail("Не дождался результата пять минут. бежать agent-autoloop doctor Проверьте.");
}

const RUN_STATES: Record<string, string> = {
  claimed: "Выполняется",
  queued: "в очереди",
  done: "Закончено",
  nothing: "NOTHING",
  unknown: "Неопределенно",
  cancelled: "Остановлено",
};

async function status(named: Flags) {
  const owner = ownerClient();
  const state = await owner.state();
  if (named.json !== undefined) return console.log(JSON.stringify(state, null, 2));
  const { totals } = state;
  const clock = { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
  const at = (iso: string) => new Date(iso).toLocaleString("ru-RU", { timeZone: state.timezone, ...clock });
  console.log(
    `Выполняется ${totals.running} · в очереди ${totals.queued} · Завершено сегодня ${totals.doneToday} · Требуется ваше действие ${state.cards.length}`,
  );
  console.log(`${spendLine(state.spending)}\n`);
  for (const agent of state.agents) console.log(`${agent.online ? "●" : "○"} ${agent.name}(${agent.worker})`);
  for (const channel of state.channels) console.log(`${channel.online ? "●" : "○"} ${channel.name}`);
  for (const card of state.cards) {
    showCard(card);
    console.log(howToAnswer(card));
  }
  const timed = [...state.lines.filter((line: { every: string | null }) => line.every), ...state.elsewhere];
  if (timed.length) console.log("\nВыбор времени");
  for (const { name, where, every, next } of timed) {
    console.log(`  ${name}${where ? `(В другом месте:${where})` : ""}:${every}, В следующий раз ${at(next)}`);
  }
  if (state.recentCards.length) console.log("\nПоследние карточки");
  for (const card of state.recentCards.slice(0, 5)) {
    const chosen = card.choice !== null ? card.options[card.choice] : card.answer;
    console.log(`  #${card.id} ${card.title}:${[chosen, card.result].filter(Boolean).join(". ") || card.text}`);
  }
  if (state.runs.length) console.log("\nПоследние циклы");
  for (const run of state.runs.slice(0, 8)) {
    const shown = run.state === "queued" && run.attempts > 0 ? "ожидает повтора" : (RUN_STATES[run.state] ?? run.state);
    const outcome = run.summary || run.error;
    console.log(`  #${run.id} ${run.rule} ${shown}${outcome ? `:${outcome}` : ""}`);
  }
  if (state.unrouted.length) console.log("\nСобытия без подходящего правила");
  for (const { source, type, subject, summary } of state.unrouted.slice(0, 5)) {
    console.log(`  ${source} ${type} ${subject}${summary ? `:${summary}` : ""}`);
  }
}

async function answer(args: string[]) {
  const { named, rest } = flags(args);
  const card = Number(rest[0]);
  if (!Number.isInteger(card) || card < 1) return fail(TAKES.answer.usage);
  const words = text(named.text);
  const done = await ownerClient().answer(card, {
    ...(rest[1] !== undefined && { choice: Number(rest[1]) - 1 }),
    ...(words && { text: words }),
  });
  console.log(
    !done.changed
      ? "Карточка уже обработана; изменений нет."
      : done.state === "closed"
        ? "Карточка закрыта."
        : "Получено,Agent Продолжить работу.",
  );
}

async function resolve(args: string[]) {
  const [id, ...words] = args;
  const card = Number(id);
  if (!Number.isInteger(card) || card < 1 || !words.length) return fail(TAKES.resolve.usage);
  const { changed } = await ownerClient().resolve(card, words.join(" "));
  console.log(changed ? "Карточка закрыта." : "Карточка уже обработана; изменений нет.");
}

async function doctor() {
  let bad = 0;
  const say = (ok: boolean, words: string) => {
    console.log(`${ok ? "●" : "○"} ${words}`);
    if (!ok) bad += 1;
  };
  say(Number(process.versions.node.split(".")[0]) >= 24, `Node ${process.versions.node}`);
  if (!existsSync(CONFIG_FILE)) return say(false, "Сначала выполните настройку командой agent-autoloop init");
  const config = readConfig();
  if (config.hub) {
    const { parseRules } = await importRules();
    try {
      const { channels } = parseRules(readFileSync(RULES_FILE, "utf8"));
      say(true, `правила ${RULES_FILE}`);
      for (const [id, channel] of Object.entries(channels)) {
        // Nobody answers from a desktop notification, and a link goes only to whoever it's sent to.
        if (id !== "desktop" && !channel.links && !channel.answerers) {
          console.log(
            `○ ${channel.name}Не указано answerers:Любой пользователь этого канала сможет отвечать на карточки.`,
          );
        }
      }
    } catch (error) {
      say(false, (error as Error).message);
    }
  }
  if (serviceRunning()) say(true, "Системная служба работает");
  else if (systemUnit()) say(true, "Служба системного уровня работает");
  else say(false, "Системная служба не работает:agent-autoloop service install");
  try {
    const health = await (await fetch(`${config.url}/healthz`, { signal: AbortSignal.timeout(5000) })).json();
    say(health.ok === true, `сервис ${config.url}(${String(health.commit).slice(0, 12)})`);
  } catch (error) {
    say(false, `Не удается подключиться к сервису ${config.url}:${(error as Error).message}`);
  }
  if (config.owner) {
    try {
      const state = await ownerClient(config).state();
      for (const agent of state.agents) {
        say(agent.online, `${agent.name}(${agent.worker})${agent.online ? "Онлайн" : "Не онлайн"}`);
        if (agent.worker === config.worker?.name) {
          const { adapterFor } = await import("../worker/agents.ts");
          const problem = await adapterFor(agent.use).then(
            (adapter) => adapter.check?.() ?? null,
            (error) => String(error.message),
          );
          say(!problem, problem ?? `${agent.name} Может быть использовано`);
        }
      }
      for (const channel of state.channels)
        say(channel.online, `${channel.name}${channel.online ? "Онлайн" : "Не онлайн"}`);
      const manual = path.join(ROOT, "skills", "agent-autoloop", "SKILL.md");
      if (!state.channels.length) {
        console.log(
          `○ Канал еще не подключен:Agent При вопросе уведомление не придет; проверяйте самостоятельно командой agent-autoloop status См. инструкцию подключения в ${manual}`,
        );
      } else if (state.channels.length === 1 && state.channels[0].id === "desktop") {
        console.log(
          "○ Подключены только уведомления рабочего стола:Agent Уведомления появляются только на этом компьютере; без графического рабочего стола или вдали от компьютера их не видно." +
            `Для подключения Feishu, DingTalk и других каналов см. ${manual}`,
        );
      }
    } catch (error) {
      say(false, `Не удалось получить состояние сервиса:${(error as Error).message}`);
    }
  }
  if (bad) process.exit(1);
}

/** The rules module reads the rules file as it loads; the checks here need to survive a bad one. */
async function importRules() {
  try {
    return await import("../host/runtime.ts");
  } catch (error) {
    fail((error as Error).message);
    throw error;
  }
}

async function check() {
  const { parseRules } = await importRules();
  parseRules(readFileSync(RULES_FILE, "utf8"));
  console.log("Правила корректны.");
}

async function key(args: string[]) {
  const [action, kind, name] = args;
  if (action === "remove") {
    if (!kind || !name) return fail("Использование: agent-autoloop key remove <тип> <имя>");
    const { changed } = await ownerClient().removeKey(kind, name);
    console.log(changed ? "Срок действия ключа истек." : "Ключ не найден; возможно, он уже удален.");
    return;
  }
  const { addKey, listKeys } = await import("../host/runtime.ts");
  if (action === "list") {
    for (const row of listKeys()) console.log(`${row.kind} ${row.name} ${row.created_at}`);
    return;
  }
  if (action !== "new" || !["source", "worker", "channel", "owner"].includes(kind) || !name) {
    return fail("Использование: agent-autoloop key new <source|worker|channel|owner> <имя>");
  }
  console.log(addKey(kind as "source", name));
}

async function emit(args: string[]) {
  const { named, rest } = flags(args);
  const config = readConfig();
  const type = rest[0] ?? fail(TAKES.emit.usage);
  const event = {
    id: text(named.id) ?? randomUUID(),
    type,
    ...(text(named.subject) && { subject: text(named.subject) }),
    ...(text(named.summary) && { summary: text(named.summary) }),
    ...(text(named.detail) && { detail: text(named.detail) }),
    ...(text(named.link) && { link: text(named.link) }),
  };
  if (named["dry-run"] !== undefined) {
    // The hub tells a source by its key, and only the key's own source is known here.
    if (text(named.key))
      return fail(
        "--dry-run Предварительный просмотр согласно источнику этого компьютера не может быть совмещен с --key использовать вместе",
      );
    if (!config.source) return fail("На этом компьютере нет ключа источника:--dry-run Требуется имя источника");
    const { previewEvent } = await import("./explain.ts");
    console.log("Предварительный просмотр (по локальным rules.json, Не подключаться к сервису, не писать логи):");
    for (const line of previewEvent(readFileSync(RULES_FILE, "utf8"), config.source.name, event)) console.log(line);
    return;
  }
  const secret =
    text(named.key) ?? config.source?.key ?? fail("На этом компьютере нет ключа источника; используйте --key");
  const answer = await client(secret, config).event(event);
  console.log(answer.routed.length ? `Передано:${answer.routed.join(", ")}` : "Записано; подходящего правила нет.");
}

async function backupCommand(args: string[]) {
  const { rest } = flags(args);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const target = path.resolve(rest[0] ?? path.join(HOME, "backups", stamp));
  const { backup } = await import("./backup.ts");
  const { files } = await backup(HOME, target);
  console.log(
    `Резервное копирование выполнено:${target}\n  ${files.join(", ")}\nсодержит ключи; храните копию безопасно. Перед восстановлением остановите сервис.`,
  );
}

async function restoreCommand(args: string[]) {
  const { named, rest } = flags(args);
  if (!rest[0]) return fail(RESTORE_USAGE);
  if (named.yes === undefined) {
    if (!process.stdin.isTTY)
      return fail(
        "Восстановление заменит локальные данные; запустить после подтверждения agent-autoloop restore <каталог> --yes",
      );
    const answer = await askAtTerminal(
      "Восстановление заменит локальную базу данных, главный ключ, конфигурацию, правила и secrets.env, Продолжить?[y/N] ",
    );
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log("Восстановление отменено.");
      return;
    }
  }
  const { restore } = await import("./backup.ts");
  const { safety } = await restore(HOME, path.resolve(rest[0]));
  console.log(
    `Восстановлено. Исходный файл находится в ${safety}. \nНачало:agent-autoloop up или agent-autoloop service install`,
  );
}

async function rulesCommand(args: string[]) {
  const { rest } = flags(args);
  if (rest[0] !== "explain" || rest.length > 1) return fail(TAKES.rules.usage);
  const { explainRules } = await import("./explain.ts");
  for (const line of explainRules(readFileSync(RULES_FILE, "utf8"), Date.now())) console.log(line);
}

async function tell(args: string[]) {
  const { named, rest } = flags(args);
  const config = readConfig();
  const matter = rest[0] ?? fail(TAKES.tell.usage);
  const words = readFileSync(0, "utf8").trim();
  if (!words) return fail("Передайте непустой текст через стандартный ввод.");
  const task = text(named.task);
  const secret = task ? config.worker?.key : config.source?.key;
  if (!secret)
    return fail(task ? "Этот компьютер не настроен как исполнитель" : "На этом компьютере нет ключа источника");
  const answer = await client(secret, config).tell({ key: matter, text: words, ...(task && { task }) });
  console.log(answer.duplicate ? "Это уведомление уже отправлено; повторной отправки нет." : "Отправлено.");
}

async function why(args: string[]) {
  const id = Number(args[0]);
  const facts = await ownerClient().why(id);
  if (args.includes("--json")) return console.log(JSON.stringify(facts, null, 2));
  const { formatWhy } = await import("./why.ts");
  console.log(formatWhy(id, facts));
}

async function checkConformance(args: string[]) {
  const { named, rest } = flags(args);
  const file = text(named.config) ?? process.env.AGENT_AUTOLOOP_CONFORMANCE;
  if (!rest[0] || !file) return fail(TAKES.conformance.usage);
  const { conformance } = await import("../protocol/conformance.ts");
  console.log(JSON.stringify(await conformance(rest[0], JSON.parse(readFileSync(file, "utf8"))), null, 2));
}

async function stop(args: string[]) {
  await ownerClient().cancel(Number(args[0]));
  console.log("Запрос остановки отправлен.");
}

function service(args: string[]) {
  if (args[0] === "install") {
    // Installing over kept data comes here and not to init, and uninstalling took the links away.
    linkSkill();
    return installService();
  }
  if (args[0] === "remove") return removeService();
  fail(TAKES.service.usage);
}

/** A plugin is a folder of its own under this install, named after its repository. */
function addPlugin(args: string[]) {
  const url = args[0] ?? fail(TAKES.add.usage);
  const name = url
    .replace(/\/$/, "")
    .split(/[/:]/)
    .at(-1)!
    .replace(/\.git$/, "")
    .toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(name))
    fail("Имя репозитория плагина может содержать строчные латинские буквы, цифры и -");
  mkdirSync(path.join(HOME, "plugins"), { recursive: true });
  const clone = spawnSync("git", ["clone", "--", url, path.join(HOME, "plugins", name)], { stdio: "inherit" });
  if (clone.status !== 0) fail("Установка не удалась.");
  console.log(`Установлено ${name}. `);
}

async function update() {
  const { updateCode } = await import("./update.ts");
  const { changed, to } = updateCode(ROOT);
  const version = to ? `(${to})` : "";
  if (!changed) return console.log(`Уже последняя${version}. `);
  const told = restartService();
  console.log(`Обновлено${version}. ${told ?? ""}`);
}

async function askAtTerminal(question: string) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await terminal.question(question);
  terminal.close();
  return answer;
}

const [command, ...args] = process.argv.slice(2);
const commands: Record<string, () => unknown> = {
  mcp: async () => (await import("./mcp.ts")).mcp(),
  add: () => addPlugin(args),
  init: () => init(args),
  join: () => join(args),
  up: async () => (await import("../host/up.ts")).up(),
  try: () => tryIt(),
  status: () => status(flags(args).named),
  why: () => why(args),
  conformance: () => checkConformance(args),
  answer: () => answer(args),
  resolve: () => resolve(args),
  doctor,
  check,
  rules: () => rulesCommand(args),
  key: () => key(args),
  emit: () => emit(args),
  tell: () => tell(args),
  stop: () => stop(args),
  backup: () => backupCommand(args),
  restore: () => restoreCommand(args),
  update,
  uninstall: async () => {
    const { uninstall } = await import("./uninstall.ts");
    await uninstall(flags(args).named.yes !== undefined, process.stdin.isTTY ? askAtTerminal : null);
  },
  service: () => service(args),
  help: () => console.log(HELP),
  "--help": () => console.log(HELP),
  "-h": () => console.log(HELP),
  "--version": () => console.log(versionLine()),
};
if (!command || !commands[command]) {
  console.log(HELP);
  if (command) process.exit(1);
} else {
  if (TAKES[command]) refuseUnknownFlags(command === "resolve" ? args.slice(0, 1) : args, TAKES[command]);
  Promise.resolve()
    .then(commands[command])
    .catch((error) => fail(error.message ?? String(error)));
}
