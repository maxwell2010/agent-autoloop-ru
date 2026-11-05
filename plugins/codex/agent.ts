// Codex: the user's own, installed and signed in by them. A run is a `codex exec` in the background; its thread is kept
// on disk, so a retry or an answer can go on in it, and the link opens it in the app.
import { execFileSync } from "node:child_process";
import { findProgram, tail, type Adapter } from "../../worker/agents.ts";

const SANDBOX = { read: "read-only", edit: "workspace-write", full: "danger-full-access" };
const IN_THE_APP = [
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
];

export default {
  command: (turn) => [
    findProgram("codex", () => IN_THE_APP),
    "exec",
    ...(turn.resume ? ["resume"] : []),
    "--json",
    "--skip-git-repo-check",
    ...(turn.model ? ["-m", turn.model] : []),
    ...(turn.effort ? ["-c", `model_reasoning_effort="${turn.effort}"`] : []),
    // As config, because `codex exec resume` takes no -s.
    "-c",
    `sandbox_mode="${SANDBOX[turn.access]}"`,
    "-c",
    'approval_policy="never"',
    ...(turn.resume ? [turn.resume] : []),
    "Этот цикл выполняется через фоновый codex exec. Не предполагается наличие браузерного подключения настольного приложения. " +
      "Для веб-операций используйте доступный в этом цикле браузерный инструмент либо явно настроенное подключение из доверенного правила или Skill. " +
      "Продолжайте сессию этого браузерного подключения; передавайте ему только веб-шаги. Бизнес-операции и результат сервиса остаются ответственностью этого цикла. Если подключения нет или восстановить его может только владелец, верните задачу с описанием требуемого действия.\n\n" +
      turn.prompt,
  ],
  read(stdout, code, stderr) {
    const seen: {
      text?: string;
      session?: string;
      sessionUsage?: object;
      error?: string;
      finished?: boolean;
      started?: boolean;
      completed?: boolean;
    } = {};
    for (const line of stdout.split("\n")) {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      // A login shell's profile prints here too, and `null` is valid JSON.
      if (!event) continue;
      if (event.type === "thread.started") seen.session = event.thread_id;
      else if (event.type === "turn.started") seen.started = true;
      else if (event.type === "item.completed" && event.item?.type === "agent_message") seen.text = event.item.text;
      else if (event.type === "turn.completed") {
        seen.completed = seen.finished = true;
        const { input_tokens = 0, output_tokens = 0, cached_input_tokens = 0 } = event.usage ?? {};
        seen.sessionUsage = { input: input_tokens, output: output_tokens, cached: cached_input_tokens };
      } else if (event.type === "turn.failed") {
        seen.finished = true;
        seen.error = event.error?.message || "Codex Цикл не завершен";
      } else if (event.type === "error") seen.error = event.message;
    }
    const { completed, ...reading } = seen;
    // Only a finished turn's last message is its answer; before that it's only as far as it had got.
    if (!completed) delete reading.text;
    if (code !== null && !completed && !reading.error)
      reading.error = tail(stderr) || "Codex не завершил работу и не оставил результата";
    if (completed && !reading.text?.trim()) reading.error = "Codex не завершил работу и не оставил результата";
    return reading;
  },
  link: (session) => `codex://threads/${session}`,
  check() {
    try {
      execFileSync(
        findProgram("codex", () => IN_THE_APP),
        ["login", "status"],
        { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] },
      );
      return null;
    } catch (error) {
      return `Codex Вход не выполнен или CLI недоступен; выполните codex login(${(error as Error).message.split("\n")[0]})`;
    }
  },
} satisfies Adapter;
