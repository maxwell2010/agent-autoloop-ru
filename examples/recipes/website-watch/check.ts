// The hub's open incident card is the checkpoint: no second scheduler, database, or pre-acknowledgement cursor.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type Target = { id: string; name: string; url: string; contains: string };
type Observation = { ok: boolean; reason: string };
type Context = { events: { id: string }[]; open: { card: number; title: string }[] };
type Receipt = {
  notice?: { key: string; title: string; text: string }[];
  resolve?: { card: number; reason: string }[];
  events?: { id: string; type: string; subject: string; summary: string; detail: string; link: string }[];
};

export async function probe(target: Target, request = fetch): Promise<Observation> {
  // Network and body-read failures are observations of the monitored site, not a successful check.
  try {
    const response = await request(target.url, {
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
      headers: { "user-agent": "agent-autoloop-site-check/1.0" },
    });
    if (response.status !== 200) return { ok: false, reason: `Возвращает ${response.status}` };
    if (!(await response.text()).includes(target.contains))
      return { ok: false, reason: "Отсутствует ожидаемое содержимое проверки работоспособности" };
    return { ok: true, reason: "состояние равно 200, И включить согласованный контент о здоровье" };
  } catch {
    return { ok: false, reason: "Подключение или чтение завершилось ошибкой либо превысило 20 секунд без завершения" };
  }
}

export function receipt(target: Target, observation: Observation, context: Context): Receipt {
  const title = `${target.name}Сейчас нормальный доступ невозможен`;
  const open = context.open.filter((card) => card.title === title);
  const changed = observation.ok ? open.length > 0 : open.length === 0;
  if (!changed) return {};
  const id = createHash("sha256")
    .update(JSON.stringify([target.id, context.events.map((e) => e.id), observation.ok]))
    .digest("hex");
  return {
    ...(observation.ok
      ? { resolve: open.map(({ card }) => ({ card, reason: `Проверка возобновилась:${observation.reason}` })) }
      : {
          notice: [
            {
              key: `site-${target.id}`,
              title,
              text: "Автоматическая проверка обнаружила ошибку; задача передана на обслуживание Agent Проверьте; эта карта будет обновлена ​​после восстановления.",
            },
          ],
        }),
    events: [
      {
        id,
        type: observation.ok ? "site.recovered" : "site.down",
        subject: target.id,
        summary: observation.ok ? "Работа сайта восстановлена" : "Мониторинг обнаружил ошибку сайта",
        detail: observation.reason,
        link: new URL(target.url).href,
      },
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target: Target = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const url = new URL(target.url);
  if (
    !/^[A-Za-z0-9_.-]{1,60}$/.test(target.id) ||
    !target.name ||
    target.name.length > 100 ||
    !target.contains ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Проверить site.json:Заполните номер сайта, имя, ключевое содержимое и информацию без учетных данных, параметров запроса или фрагментов. HTTP адрес",
    );
  }
  const context: Context = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT!, "utf8"));
  const observation = await probe(target);
  console.log(
    `Проверка завершена:${observation.reason}\n\n\`\`\`agent-autoloop\n${JSON.stringify(receipt(target, observation, context))}\n\`\`\``,
  );
}
