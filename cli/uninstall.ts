// `agent-autoloop uninstall`: takes away what the install put on this computer and nothing else. A link is ours only if it really
// leads to this program: someone else's agent-autoloop, or a folder of their own by that name, stays where it is.
import { existsSync, lstatSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HOME } from "../host/home.ts";
import { removeService, stopUp } from "../host/service.ts";

const ROOT = path.join(import.meta.dirname, "..");

function removeLink(link: string, target: string) {
  if (!lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) return;
  try {
    if (realpathSync(link) !== realpathSync(target)) return;
  } catch {
    return; // It leads nowhere, so not here.
  }
  // Not rmSync: Node 25.1 refuses it for a link that leads to a folder.
  unlinkSync(link);
  console.log(`удалено ${link}`);
}

function removeLinks() {
  const program = path.join(ROOT, "bin", "agent-autoloop.ts");
  const onPath = (process.env.PATH ?? "").split(path.delimiter).filter((place) => path.isAbsolute(place));
  const places = [path.join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", ...onPath];
  for (const place of new Set(places)) removeLink(path.join(place, "agent-autoloop"), program);
  const skill = path.join(ROOT, "skills", "agent-autoloop");
  for (const agent of [".claude", ".codex"]) removeLink(path.join(homedir(), agent, "skills", "agent-autoloop"), skill);
}

/** Confirmation is about removing the program; data is never part of this command. */
export async function uninstall(yes: boolean, ask: ((question: string) => Promise<string>) | null) {
  if (!yes) {
    if (!ask)
      throw new Error(
        "Выполните agent-autoloop uninstall --yes При удалении программы правила, ключи и записи сохраняются.",
      );
    if (!/^y(es)?$/i.test((await ask("Удалить программу и сохранить данные?[y/N] ")).trim())) {
      console.log("Удаление отменено.");
      return;
    }
  }
  removeService();
  stopUp();
  removeLinks();
  const installedApp = path.join(HOME, "app");
  if (existsSync(installedApp) && realpathSync(installedApp) === realpathSync(ROOT)) {
    rmSync(installedApp, { recursive: true });
  }
  console.log(existsSync(HOME) ? `Удалено. Правила, ключи и записи остаются ${HOME}. ` : "Удалено.");
}
