#!/bin/sh
# The one thing here that touches production. It runs outside any sandbox, as you, whatever access the Agent has.
# It can run twice: a failure is tried again, and the hub only promises at least once.
set -e
echo "Это скрипт-заглушка: настоящий перезапуск не выполнен. Замените строку командой перезапуска и проверкой работоспособности. Первая строка вывода будет отправлена вам."
