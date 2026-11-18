#!/bin/bash
# Ярлык «WB Офис» на Рабочем столе Mac: `npm run office:shortcut`.
#
# Создаёт ~/Desktop/WB Офис.command. Двойной щелчок открывает Терминал,
# в нём запускается `npm run office:web` в папке набора, а через 3 секунды
# браузер открывает http://localhost:3000. Закрыли окно — офис остановился.
# Без sudo и без скачивания. Запускать повторно можно — файл перезапишется.

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP="$HOME/Desktop"
TARGET="$DESKTOP/WB Офис.command"

mkdir -p "$DESKTOP"

# Путь к набору — в одинарных кавычках, с экранированными апострофами.
QROOT="'${ROOT//\'/\'\\\'\'}'"

cat > "$TARGET" <<EOF
#!/bin/bash
# WB Офис — запускает 3D-офис магазина. Создан командой npm run office:shortcut.
# Node из установщика nodejs.org лежит в /usr/local/bin, из Homebrew на M1+ — в /opt/homebrew/bin.
export PATH="/opt/homebrew/bin:/usr/local/bin:\$PATH"
cd $QROOT || { echo "Папка набора не найдена: $ROOT. Запустите npm run office:shortcut заново из папки набора."; read -r; exit 1; }
if ! command -v npm >/dev/null 2>&1; then
  echo "Не найден Node.js. Установите Node.js 22 LTS с nodejs.org и откройте ярлык снова."
  read -r
  exit 1
fi
(sleep 3; if command -v open >/dev/null 2>&1; then open http://localhost:3000; else xdg-open http://localhost:3000; fi) >/dev/null 2>&1 &
npm run office:web
EOF

chmod +x "$TARGET"

echo "Готово: на Рабочем столе файл «WB Офис.command»."
echo "Двойной щелчок — офис запустится и откроется в браузере (http://localhost:3000)."
echo "Первый раз macOS может спросить разрешение: щёлкните по файлу правой кнопкой → Открыть."
echo "Остановить — закрыть окно Терминала. Если папку набора перенесёте — запустите npm run office:shortcut ещё раз."
