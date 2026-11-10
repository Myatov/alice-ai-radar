#!/usr/bin/env bash
# Выкладка обновлений на alice.seo-performance.ru (пользователь aliceseo, без root).
# Запуск из корня проекта: ./deploy/deploy.sh
# База data/ и .env на сервере НЕ перезаписываются — у прода своя копия.
set -euo pipefail

HOST=aliceseo@5.63.155.249
ROOT=/var/www/alice.seo-performance.ru
cd "$(dirname "$0")/.."

rsync -az --delete src package.json deploy/ecosystem.config.cjs "$HOST:$ROOT/app/"
rsync -az --delete public/ deploy/public_html/ "$HOST:$ROOT/public_html/"
ssh "$HOST" 'cd ~/app && pm2 startOrRestart ecosystem.config.cjs --update-env && pm2 save'

curl -fsS https://alice.seo-performance.ru/api/config && echo && echo "OK: задеплоено"
