// `agent-autoloop mcp`: the hub's doors as MCP tools over stdio, using the keys already in this machine's config.json.
import { readConfig } from "../host/config.ts";
import { eachLine } from "../host/lines.ts";
import { versionName } from "../host/version.ts";
import { hubClient, type Hub } from "../protocol/client.ts";

const positive = { type: "integer", minimum: 1 };
const string = { type: "string", minLength: 1 };
const specs = [
  ["status", "Показать текущие дела и карточки", {}, []],
  ["why", "Показать события, правило и результат цикла", { run: positive }, ["run"]],
  [
    "answer",
    "Ответить на карточку; choice начинается с 0, вместо варианта можно передать текст ответа",
    { card: positive, choice: { type: "integer", minimum: 0 }, text: string },
    ["card"],
  ],
  ["resolve", "Закрыть карточку с проверенным результатом", { card: positive, reason: string }, ["card", "reason"]],
  ["stop", "Остановить один цикл", { run: positive }, ["run"]],
  [
    "emit",
    "Отправить событие от локального источника; одинаковый ID учитывается один раз",
    { id: string, type: string, subject: string, summary: string, detail: string, link: string },
    ["id", "type"],
  ],
  [
    "tell",
    "Отправить уведомление от локального источника; одинаковый ID отправляется один раз",
    { key: string, text: string },
    ["key", "text"],
  ],
] as const;

const usesSourceKey = (name: string) => ["emit", "tell"].includes(name);

function toolsFor(config: ReturnType<typeof readConfig>) {
  return specs
    .filter(([name]) => (usesSourceKey(name) ? config.source : config.owner))
    .map(([name, description, properties, required]) => ({
      name,
      description,
      inputSchema: { type: "object", properties, required, additionalProperties: false },
      annotations: { readOnlyHint: ["status", "why"].includes(name), destructiveHint: name === "stop" },
    }));
}
type Tool = ReturnType<typeof toolsFor>[number];

function validArguments(tool: Tool, args: any) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  if (!tool.inputSchema.required.every((key) => Object.hasOwn(args, key))) return false;
  const properties = tool.inputSchema.properties as Record<string, any>;
  const fits = ([key, value]: [string, unknown]) => {
    const schema = properties[key];
    if (!schema) return false;
    if (schema.type === "integer") return Number.isSafeInteger(value) && (value as number) >= schema.minimum;
    return typeof value === "string" && value.trim().length > 0;
  };
  if (!Object.entries(args).every(fits)) return false;
  return tool.name !== "answer" || (args.choice !== undefined) !== (args.text !== undefined);
}

function callTool(hub: Hub, name: Tool["name"], args: any) {
  switch (name) {
    case "status":
      return hub.state();
    case "why":
      return hub.why(args.run);
    case "answer": {
      const { card, ...answer } = args;
      return hub.answer(card, answer);
    }
    case "resolve":
      return hub.resolve(args.card, args.reason);
    case "stop":
      return hub.cancel(args.run);
    case "emit":
      return hub.event(args);
    case "tell":
      return hub.tell(args);
  }
}

export async function mcp() {
  const config = readConfig();
  const tools = toolsFor(config);
  let initialized = false;
  let ready = false;
  const reply = (id: unknown, body: object) => console.log(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
  const refuse = (id: unknown, code: number, message: string) => reply(id, { error: { code, message } });

  async function answerCall(id: unknown, params: any) {
    const tool = tools.find((tool) => tool.name === params?.name);
    const args = params?.arguments ?? {};
    if (!tool || !validArguments(tool, args)) return refuse(id, -32602, "Неверное имя или параметры инструмента.");
    const hub = hubClient(config.url, usesSourceKey(tool.name) ? config.source!.key : config.owner!);
    try {
      const result = await callTool(hub, tool.name, args);
      reply(id, { result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
    } catch (error) {
      reply(id, { result: { isError: true, content: [{ type: "text", text: (error as Error).message }] } });
    }
  }

  eachLine(process.stdin, (line) => {
    let request: any;
    try {
      request = JSON.parse(line);
    } catch {
      return refuse(null, -32700, "Нет JSON");
    }
    if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return refuse(request?.id ?? null, -32600, "Некорректный формат запроса");
    }
    const { id, method, params } = request;
    if (id === undefined) {
      if (method === "notifications/initialized" && initialized) ready = true;
    } else if (method === "initialize") {
      if (!params?.protocolVersion || !params?.capabilities || !params?.clientInfo) {
        return refuse(id, -32602, "Не заданы параметры инициализации");
      }
      initialized = true;
      const serverInfo = { name: "agent-autoloop", version: versionName() };
      reply(id, { result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo } });
    } else if (method === "ping") reply(id, { result: {} });
    else if (!ready) refuse(id, -32600, "Завершите сначала initialize");
    else if (method === "tools/list") reply(id, { result: { tools } });
    // Each answers by itself, however long it takes: a client's ping has to get through meanwhile.
    else if (method === "tools/call") void answerCall(id, params);
    else refuse(id, -32601, "Метод не найден");
  });
}
