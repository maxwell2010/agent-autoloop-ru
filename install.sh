#!/bin/sh
# Installs Agent Сервис автоматизации: a clone in ~/.agent-autoloop/app, with nothing to build and nothing else to install.
set -e
PUBLISHED=https://github.com/maxwell2010/agent-autoloop-ru.git
REPO="${AGENT_AUTOLOOP_REPO:-$PUBLISHED}"
ROOT="${AGENT_AUTOLOOP_HOME:-$HOME/.agent-autoloop}"
APP="$ROOT/app"
PROGRAM="$APP/bin/agent-autoloop.ts"

need_node() {
  echo "$1"
  cat <<'END'
При использовании Homebrew добавьте node@24 в PATH. Выполните все три команды
(для bash замените ~/.zshrc на ~/.bashrc):
  brew install node@24
  echo "export PATH=\"$(brew --prefix node@24)/bin:\$PATH\"" >> ~/.zshrc
  source ~/.zshrc
При использовании nvm:
  nvm install 24
  nvm alias default 24
После установки повторите команду установки.
END
  exit 1
}

command -v git >/dev/null || { echo "Требуется Git."; exit 1; }
command -v node >/dev/null || need_node "Требуется Node.js 24 или новее; Node на этом компьютере не найден."
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || need_node "Требуется Node.js 24 или новее, сейчас установлен $(node -v)."

mkdir -p -m 700 "$ROOT"
chmod 700 "$ROOT"

# Where a repository really is, however it's written: git keeps a path as it was given, and it may come with file:// or
# through a link.
place() {
  where=${1#file://}
  if [ -d "$where" ]; then (CDPATH= cd -- "$where" && pwd -P); else printf '%s\n' "$1"; fi
}

# A copy follows where it came from, and what came from the public repository follows its newest release, which has passed
# every check. cli/update.ts decides the same way, or an update would fail on a copy this had moved.
from="$REPO"
if [ -d "$APP/.git" ]; then
  from=$(git -C "$APP" config --get remote.origin.url || true)
  # Going on would say it had updated, and leave this copy following where it came from.
  if [ -n "${AGENT_AUTOLOOP_REPO:-}" ] && [ "$(place "$from")" != "$(place "$REPO")" ]; then
    echo "Программа уже установлена из $from，Нет $REPO。Для смены источника сначала выполните agent-autoloop uninstall Переустановите."
    exit 1
  fi
fi
release=""
if [ "$from" = "$PUBLISHED" ]; then
  # On a line of its own: in a pipe, not getting an answer would look like there being no releases.
  tags=$(git ls-remote --refs --tags "$PUBLISHED" 'v*')
  release=$(printf '%s\n' "$tags" | sed -n 's#.*refs/tags/\(v[0-9]*\.[0-9]*\.[0-9]*\)$#\1#p' |
    sort -t. -k1.2,1n -k2,2n -k3,3n | tail -n 1)
fi
if [ ! -d "$APP/.git" ]; then
  git -c advice.detachedHead=false clone --quiet --depth 1 ${release:+--branch "$release"} -- "$REPO" "$APP"
elif [ -n "$release" ]; then
  git -C "$APP" fetch --quiet --depth 1 origin "refs/tags/$release:refs/tags/$release"
  git -C "$APP" checkout --quiet --detach "$release"
else
  git -C "$APP" pull --ff-only --quiet
fi

# Only a folder that's on PATH makes `agent-autoloop` work, and an agent-autoloop that isn't this one is someone else's to keep.
place_link() {
  case ":$PATH:" in *":$1:"*) ;; *) return 1 ;; esac
  case "$1" in /*) ;; *) return 1 ;; esac
  if [ "$1" = "$HOME/.local/bin" ]; then mkdir -p "$1" 2>/dev/null || return 1; fi
  [ -d "$1" ] && [ -w "$1" ] || return 1
  if [ -e "$1/agent-autoloop" ] || [ -L "$1/agent-autoloop" ]; then
    [ -L "$1/agent-autoloop" ] && [ "$1/agent-autoloop" -ef "$PROGRAM" ] || return 1
  fi
  ln -sf "$PROGRAM" "$1/agent-autoloop"
}

usual_ifs=$IFS
IFS=:
set -f
for place in "$HOME/.local/bin" $PATH; do
  if place_link "$place"; then break; fi
done
set +f
IFS=$usual_ifs

if [ "${1:-}" = join ]; then
  "$PROGRAM" "$@"
elif [ -f "$ROOT/config.json" ]; then
  echo "Обновление завершено."
  case " $* " in *" --no-service "*) ;; *) "$PROGRAM" service install ;; esac
else
  "$PROGRAM" init "$@"
fi

if ! [ "$(command -v agent-autoloop)" -ef "$PROGRAM" ]; then
  echo
  echo "выполнить напрямую agent-autoloop Не удалось запустить программу:PATH Не существует каталога, в котором ее можно поместить, или первой указана другая программа с таким же именем."
  echo "Укажите полный путь $PROGRAM，Или добавьте эту строку в ~/.zshrc（использовать bash То есть ~/.bashrc）："
  echo "  alias agent-autoloop='$PROGRAM'"
fi
