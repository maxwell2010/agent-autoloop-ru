// Vendor message formats: links are listed in protocol.md so the fields can be checked against their owning APIs.
export function payload(platform: string, text: string): object {
  if (platform === "discord" && [...text].length > 2000)
    throw new Error("Discord Сообщение превышает 2000 слова, пожалуйста, сократите открытку");
  if (platform === "wecom" && Buffer.byteLength(text) > 2048)
    throw new Error("Сообщения Enterprise WeChat превышают 2048 Байты, пожалуйста, сократите карту");
  switch (platform) {
    case "dingtalk":
      return { msgtype: "text", text: { content: text }, at: { isAtAll: false } };
    case "wecom":
      return { msgtype: "text", text: { content: text } };
    case "slack":
      return { text, mrkdwn: false, unfurl_links: false, unfurl_media: false };
    case "discord":
      return { content: text, allowed_mentions: { parse: [] } };
    default:
      throw new Error(`Не найдено Webhook Шаблон:${platform}`);
  }
}

export async function accepted(platform: string, response: Response) {
  if (!response.ok) throw new Error(`Возвращает ${response.status}`);
  if (platform === "dingtalk" || platform === "wecom") {
    const result = await response.json();
    if (result.errcode !== 0) throw new Error(`Отправка не удалась:${result.errmsg ?? result.errcode}`);
  } else if (platform === "slack" && (await response.text()).trim() !== "ok")
    throw new Error("Slack Получение сообщения не подтверждено");
}
