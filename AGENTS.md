# AGENTS.md — рабочие правила проекта site_korovki

## Назначение

Этот файл — краткая карта проекта для Codex и других разработчиков. Перед изменениями нужно проверить `git status`, прочитать этот файл и не затирать чужие незакоммиченные изменения.

## Репозиторий и границы изменений

- Локальный проект: `C:\Users\Windows\projects\site_korovki`.
- Git remote: `https://github.com/baton880/web.git`, основная ветка: `main`.
- Перед синхронизацией с GitHub: `git fetch origin`, затем `git rev-list --left-right --count HEAD...origin/main`.
- Не делать commit/push автоматически. Если локальная ветка опережает GitHub, сначала показать разницу и оставить изменения локально.
- Сохранять существующие изменения пользователя, особенно в `!LOADER_CODE`.
- Рабочие БД, серверные снимки, логи и экспериментальные артефакты хранить в `C:\Users\Windows\projects\tmp`, а не в Git-репозитории.

## Структура

- `server/` — Express API, Prisma, SQLite и фоновые scheduler-ы.
- `server/src/modules/telemetry/` — приём host/RTK-телеметрии, effective position и replay scheduler.
- `server/src/modules/batches/` — замесы, нарушения и batch postprocessing.
- `server/scripts/replay-batches-from-telemetry.mjs` — полный replay исходной телеметрии в вычисляемые замесы.
- `server/src/modules/batches/batch-postprocess-service.js` и `weight-step-postprocess.js` — постпроцессинг замесов и ступенек веса.
- `module-1/` — география и зоны; `module-2/` — рацион/округление веса; `module-3/` — FSM телеметрии.
- `frontend/` — статический интерфейс, который отдаёт `server/src/index.js`.

## Локальный запуск

Из корня проекта:

```powershell
cd C:\Users\Windows\projects\site_korovki\server
$env:PORT = "3000"
$env:DATABASE_URL = "file:C:/Users/Windows/projects/tmp/<snapshot>/replay-dev.db"
node src/index.js
```

Проверка: `Invoke-WebRequest http://127.0.0.1:3000/api/health` и открытие `http://127.0.0.1:3000/`.

## Работа со свежей серверной БД

- Не работать прямо с production-файлом и не заменять `server/prisma/dev.db` без отдельного согласования.
- Сначала скачать новый снимок в `tmp`, проверить SHA-256 и `PRAGMA integrity_check`.
- Исходная БД содержит сырую host-телеметрию в `Telemetry`, сырые RTK-пакеты в `RtkTelemetry` и raw payload-поля. Отдельные плохие RTK-запросы могут лежать в `server/runtime/rtk-ingest-dead-letter.jsonl`.
- Для экспериментов сделать копию snapshot-БД и использовать её через `DATABASE_URL`.

## Полный replay и постпроцессинг

Команда запускается из `server/`, с `DATABASE_URL`, указывающим на экспериментальную копию БД:

```powershell
$env:DATABASE_URL = "file:C:/Users/Windows/projects/tmp/<snapshot>/replay-dev.db"
node scripts/replay-batches-from-telemetry.mjs
```

Скрипт очищает и заново строит вычисляемые `Batch`, `BatchIngredient`, `Violation`, затем выполняет batch postprocessing и пересчитывает нарушения. `Telemetry`, `RtkTelemetry`, зоны, рационы, группы и настройки он не должен удалять.

Полезные переменные replay: `REPLAY_FROM` для ограничения начала периода, `REPLAY_APPLY_WEIGHT_CALIBRATION=true` для применения калибровки веса, `REPLAY_BATCH_ID_SEQUENCE_START` для управления стартом sequence. Для полной свежей БД обычно переменные не задавать.

## Проверки после обработки

- Проверить завершение процесса и финальную сводку `Replay complete`.
- Снова выполнить SQLite `integrity_check` и посчитать `Telemetry`, `RtkTelemetry`, `Batch`, `BatchIngredient`, `Violation`.
- Убедиться, что исходные строки `Telemetry` и `RtkTelemetry` не изменились по количеству и диапазону времени.
- Проверить `GET /api/health`, главную страницу и логи сайта на портe 3000.
- При диагностике сравнивать результаты с отдельной копией БД, не с production.

## Документация и обновление этого файла

После существенных изменений обновлять этот файл: команды запуска, расположение данных, известные ограничения и проверенные результаты. Не добавлять сюда пароли, JWT_SECRET, SMTP-секреты или другие credentials. В конце задачи кратко фиксировать дату, что проверено и какие артефакты созданы.

## Состояние на 2026-07-15

- После `git fetch origin`: `HEAD...origin/main = 0 0`; commit/pull не выполнялись.
- В рабочем дереве уже были пользовательские изменения в `!LOADER_CODE`; их не изменять и не коммитить без явной команды.
- Для текущей локальной проверки используется снимок `C:\Users\Windows\projects\tmp\server_snapshot_20260715`.

## Последняя проверка данных на 2026-07-15

- С сервера скачаны `server-dev.db`, `rtk-ingest-dead-letter.jsonl` и `farm-site-full_20260711_220010.tar.gz`; SHA-256 скачанных файлов совпал с сервером.
- Исходный снимок прошёл `PRAGMA integrity_check`.
- Для полного исторического replay локальный сервер запускать с `DATA_RETENTION_ENABLED=false`: обычный scheduler удаляет raw-телеметрию старше 14 дней. Первый пробный запуск это обнаружил и был откатан заменой рабочей копии из чистого snapshot.
- Replay полной телеметрии: 341417 host-пакетов и 27297 RTK-пакетов; 123 замеса, 778 ингредиентов, 293 нарушения, 0 активных замесов. Postprocessing выполнен для 123/123 замесов.
- После replay исходные таблицы `Telemetry` и `RtkTelemetry` сохранили исходные количества и диапазоны времени; рабочая БД снова прошла `integrity_check`.
- Сайт запущен локально на `http://127.0.0.1:3000`; `/api/health` и `/` отвечают HTTP 200. Логи снимка: `tmp/server_snapshot_20260715/local-site-3000.out.log` и `local-site-3000.err.log`.
- Финальная обработанная БД сохранена в `tmp/farm-dev-latest-20260715-replayed.db` и установлена как `tmp/dev.db`; прежний файл сохранён в `tmp/dev-before-server-replay-20260715.db`.
- Карты главной и замеса: разрывы треков host/погрузчика рисуются отдельно как пунктир. Для не-админов такие сегменты, а также пунктирные линии ингредиентных участков на карте замеса, не отображаются. Администратор может отдельно включать/выключать разрывы host и погрузчика; выбор сохраняется в `localStorage` браузера.
