#!/bin/sh
# Регулярно заглядывайте GitHub Проверить наличие новых issue，Если новых данных нет, токены не расходуются Token。Промежуточную станцию можно использовать дома, даже если она не подключена к сети общего пользования.
#
#   "agents": { "watcher": { "name": "Опрос", "worker": "my-mac", "use": "command", "command": ["/абсолютный путь/watch-github-issues.sh", "owner/repo", "created:>=2026-11-04"] } }
#   "rules": [
#     { "name": "Проверить новые issue", "when": { "cron": "*/5 * * * *" }, "to": "watcher", "cwd": "~/", "tell": "never", "emits": { "source": "github", "types": ["issues.opened"] } },
#     { "name": "Обработка issue", "when": { "source": "github", "types": ["issues.opened"] }, "to": "claude", "cwd": "~/code/app", "skill": "handle-issue", "parallel": 1 }
#   ]
#
# Второй параметр необязателен и задает GitHub условия поиска:created:>=дата Взгляните только на те, что открылись после этого дня,label:agent Смотрите только на тех, у кого есть этот тег. Не написано все открыто.
# Курсора не осталось: каждый раз читайте последнее событие id стабилен; повторное событие сервис учитывает только один раз.
# Подготовленные примеры: examples/recipes/github-issues。
set -e
REPO="$1"
SEARCH="${2:-}"
EVENTS=$(gh issue list --repo "$REPO" --state open --limit 30 ${SEARCH:+--search "$SEARCH"} --json number,title,url,body \
  --jq 'map({id: ("issue-" + (.number|tostring)), type: "issues.opened", subject: ("#" + (.number|tostring)), summary: .title[0:200], detail: .body[0:4000], link: .url})')
echo "Просмотрено $REPO последний issue"
echo
echo '```agent-autoloop'
# Not echo: /bin/sh's echo turns the \n and \\ inside the JSON into real ones.
printf '{"events":%s}\n' "$EVENTS"
echo '```'
