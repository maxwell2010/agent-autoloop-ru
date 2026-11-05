// Keep Feishu credentials in its CLI; only complete, reader-scoped snapshots can wake the summarizer.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Report = {
  task_id: string;
  rule_name: string;
  from_user_id: string;
  commit_time: number;
  form_contents: unknown[];
};
type Table = { name: string; baseToken: string; tableId: string; fields: string[]; url: string };
type Sources = { reportRule: string; reportUsers: string[]; tables: Table[] };
class AuthorizationError extends Error {}

function lark(args: string[]) {
  const run = spawnSync("lark-cli", [...args, "--as", "user"], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  const response = JSON.parse(run.status === 0 ? run.stdout : run.stderr);
  if (response.error?.type === "authorization" || response.error?.type === "authentication")
    throw new AuthorizationError();
  if (run.status !== 0 || response.ok !== true)
    throw new Error(
      `Не удалось прочитать Feishu:${response.error?.type ?? "Неизвестная ошибка"}, Проверьте на этом компьютере CLI`,
    );
  if (response.identity !== "user") throw new Error("Чтение Feishu выполнено без идентичности владельца");
  return response.data;
}

const context = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT!, "utf8"));
const blockedTitle = "Восстановите чтение данных Feishu";
if (
  context.answers.length &&
  !context.answers.some(
    (answer: { title: string; choice: number | null }) => answer.title === blockedTitle && answer.choice === 0,
  )
) {
  console.log("NOTHING: Восстановление в этом цикле не подтверждено; дождитесь следующего чтения по расписанию");
} else if (context.open.some((card: { title: string }) => card.title === blockedTitle) && !context.answers.length) {
  console.log("NOTHING: Ожидание восстановления доступа владельца к данным Feishu");
} else {
  const sources: Sources = JSON.parse(readFileSync(process.argv[2], "utf8"));
  if (
    !sources.reportRule ||
    !sources.reportUsers.length ||
    sources.reportUsers.some((id) => !id.startsWith("ou_")) ||
    sources.tables.some((table) => !table.baseToken || !table.tableId || !table.fields.length || !table.name)
  ) {
    throw new Error("Проверить sources.json:Укажите правила отчетности, персонал, формы и необходимые поля.");
  }
  const folder = mkdtempSync(".brief-");
  try {
    const until = Math.floor(Date.now() / 1000);
    const from = until - 7 * 86_400;
    const reports: Report[] = [];
    for (const user of sources.reportUsers) {
      let page = "";
      do {
        const data = lark([
          "api",
          "POST",
          "/open-apis/report/v1/tasks/query",
          "--params",
          '{"user_id_type":"open_id"}',
          "--data",
          JSON.stringify({
            commit_start_time: from,
            commit_end_time: until,
            user_id: user,
            page_token: page,
            page_size: 20,
          }),
        ]);
        if (!Array.isArray(data.items))
          throw new Error("Feishu не вернул список отчетов; это нельзя считать отсутствием отчетов");
        reports.push(
          ...data.items.filter(
            (r: Report) =>
              r.from_user_id === user &&
              r.rule_name === sources.reportRule &&
              r.commit_time >= from &&
              r.commit_time <= until,
          ),
        );
        if (data.has_more && (!data.page_token || data.page_token === page))
          throw new Error("Некорректный маркер пагинации отчета; данные неполные");
        page = data.has_more ? data.page_token : "";
      } while (page);
    }
    const tables = [];
    for (const [index, table] of sources.tables.entries()) {
      const records = [];
      let offset = 0;
      let revision: string | number | undefined;
      for (;;) {
        const output = join(folder, `${index}-${offset}.ndjson`);
        lark([
          "base",
          "+record-list",
          "--base-token",
          table.baseToken,
          "--table-id",
          table.tableId,
          ...table.fields.flatMap((field) => ["--field-id", field]),
          "--offset",
          String(offset),
          "--limit",
          "2000",
          "--format",
          "ndjson",
          "--output",
          output,
        ]);
        const manifest = JSON.parse(readFileSync(output.replace(/\.ndjson$/, ".manifest.json"), "utf8"));
        if (offset && manifest.rev !== revision)
          throw new Error("Версия таблицы изменилась во время чтения; сводка в этом цикле не создается");
        revision = manifest.rev;
        records.push(
          ...readFileSync(output, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        );
        if (manifest.has_more === false) break;
        if (manifest.has_more !== true || !Number.isInteger(manifest.next_offset) || manifest.next_offset <= offset)
          throw new Error("Некорректная пагинация таблицы; данные неполные");
        offset = manifest.next_offset;
      }
      tables.push({ name: table.name, url: table.url, fields: table.fields, records });
    }
    const content = {
      from: new Date(from * 1000).toISOString(),
      until: new Date(until * 1000).toISOString(),
      reports,
      tables,
    };
    const id = createHash("sha256").update(JSON.stringify(content)).digest("hex");
    writeFileSync("weekly-input.json.tmp", JSON.stringify({ id, ...content }, null, 2), { mode: 0o600 });
    renameSync("weekly-input.json.tmp", "weekly-input.json");
    console.log(
      `Чтение данных завершено\n\n\`\`\`agent-autoloop\n${JSON.stringify({ events: [{ id, type: "brief.ready", subject: "weekly", summary: "Данные Feishu за текущий период прочитаны полностью" }] })}\n\`\`\``,
    );
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    console.log(
      `Ожидание обработки: возобновите чтение данных Feishu.\n\n\`\`\`agent-autoloop\n${JSON.stringify({
        ask: [
          {
            key: "feishu-access",
            title: blockedTitle,
            text: "На компьютере исполнителя восстановите вход владельца в Feishu или права чтения нужных данных, затем выберите продолжение. Старые данные не считаются результатом текущего периода.",
            options: ["Восстановлено, продолжить чтение", "Пропустить этот период"],
            recommend: 0,
            about:
              "Повторно прочитайте отчеты текущего периода и заданные таблицы; передайте данные для сводки только после полного успешного чтения Agent. ",
          },
        ],
      })}\n\`\`\``,
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
