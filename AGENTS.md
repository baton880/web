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

## Последний replay на 2026-07-16

- Свежий целостный снимок расположен в `C:\Users\Windows\projects\tmp\server_snapshot_20260716\server-dev.db`; рабочая обработанная копия — `replay-dev.db` в том же каталоге. Исходный snapshot не изменять.
- Перед replay текущий код требует миграцию `20260715000100_add_rtk_ingest_key`: запускать `npx prisma migrate deploy` с `DATABASE_URL`, указывающим на рабочую копию. В production-снимке колонки `RtkTelemetry.ingestKey` на момент скачивания не было.
- Полный replay завершён успешно: 338085 `Telemetry`, 28719 `RtkTelemetry`, 120 `Batch`, 743 `BatchIngredient`, 305 `Violation`; `PRAGMA integrity_check = ok`. Postprocessing выполнен для 120/120 завершённых замесов.
- Локальный сайт запущен на `http://127.0.0.1:3000` с этой рабочей БД, `DATA_RETENTION_ENABLED=false` и `RTK_BUFFER_REPLAY_ENABLED=0`; логи: `tmp/server_snapshot_20260716/local-site-3000.out.log` и `local-site-3000.err.log`.

## Production-деплой 2026-07-16

- Сервер `/opt/farm-server` обновлён fast-forward до `a62e346` (`Add admin controls for dashed map gaps`), зависимости установлены через `npm ci`, миграция `20260715000100_add_rtk_ingest_key` применена.
- Перед деплоем создан и проверен полный архив `/opt/backups/farm-site/farm-site-full_20260716_105310.tar.gz`; отдельный целостный SQLite-снимок: `/opt/backups/farm-site/server-dev-before-deploy_20260716_105309.db`.
- После первого запуска новый retention scheduler удалил 9859 старых host-пакетов по политике 14 дней. Пакеты восстановлены из преддеплойного SQLite-снимка, а в production `.env` установлено `DATA_RETENTION_ENABLED=false`, чтобы сохранять полную raw-историю для будущих replay.
- Финальный полный replay выполнен по 349418 `Telemetry` и 31113 `RtkTelemetry`: 121 `Batch`, 747 `BatchIngredient`, 318 `Violation`, 0 открытых замесов; postprocessing выполнен для 121/121 завершённых замесов.
- После запуска production-БД прошла `PRAGMA integrity_check = ok`; локальный и публичный `/api/health`, а также `https://vi-korm.ru/` отвечают успешно. PM2-приложение `farm-server` запущено online.

## Production-инцидент SQLite 2026-07-16

- После деплоя массовая досылка старого host-буфера запланировала автоматический полный replay. Replay, live host-транзакции и RTK worker одновременно писали в SQLite; Prisma начала возвращать `P1008/P2028`, а nginx — `504` для треков, замесов и админки. Сам файл БД оставался исправным и проходил `quick_check`.
- Hotfix `49d5ff2` приостанавливает записи host и обработку RTK durable inbox на время рассчитанного replay: host получает retryable HTTP 503 и сохраняет пакет на устройстве, RTK остаётся в inbox; после replay оба потока автоматически продолжаются.
- `RTK_BUFFER_REPLAY_ENABLED=1` возвращён после деплоя hotfix. `DATA_RETENTION_ENABLED=false` оставлен намеренно для сохранения полной raw-истории.
- В nginx добавлен защитный лимит только для `POST /api/telemetry/host`: 4 запроса/с с небольшим burst и HTTP 503 на превышение. Штатная частота 1 запрос/с не ограничивается; всплеск старого буфера выгружается постепенно без потери данных.
- После исправления `/api/batches`, host/RTK recent/current и host admin history отвечали за 5–14 мс, health — за несколько миллисекунд; RTK inbox имел только `processed` записи, новых ошибок блокировки после рестарта не было.

## Повторный SQLite-инцидент и безопасный replay 2026-07-17

- Причина повторения: проверка `replayRunning` останавливала только новые host/RTK-записи, но replay не ждал завершения запросов, которые уже прошли проверку и выполняли чтение/транзакцию. Старый host-буфер продолжал ставить полные replay, конкурентные писатели вызывали `P1008/P2028`, nginx `504` и клиентские `499`.
- Перед стабилизацией созданы и проверены: `/opt/backups/farm-site/server-dev-before-replay-stabilization_20260717_042355.db`, копия production `.env` и `/opt/backups/farm-site/farm-nginx-before-replay-stabilization_20260717_042355.conf`. Production-БД прошла `quick_check`.
- Для аварийной разгрузки `RTK_BUFFER_REPLAY_ENABLED` временно установлен в `0`; `DATA_RETENTION_ENABLED=false` и nginx-лимит host ingest 4 запроса/с не менялись. Перед возвратом автопересчёта дождаться: RTK `pending/retry/processing = 0`, 30 минут без host-пакетов с задержкой более 5 минут, актуальные timestamps отстают не более чем на 2 минуты.
- Новый `telemetry-write-coordinator.js` закрывает admission перед replay, считает активных host/RTK-писателей и позволяет scheduler запустить дочерний процесс только после полного drain. Host в закрытом окне получает retryable `503`; RTK остаётся в отдельном durable inbox.
- Replay-сигналы объединяются, стандартный quiet window — 30 минут. Состояния scheduler: `idle`, `draining`, `running`, `backoff`; после ошибки применяется ограниченный экспоненциальный backoff без немедленного повторного запуска.
- Полный replay выполняет очистку, построение и постпроцессинг `Batch`, `BatchIngredient`, `Violation` в одной Prisma-транзакции. Ошибка откатывает все расчётные изменения; raw `Telemetry`/`RtkTelemetry` не меняются.
- `/api/health` дополнительно возвращает `calculatedReplay`, `telemetryWriters` и безопасную сводку `rtkIngress`. Основные параметры: `TELEMETRY_BUFFER_REPLAY_DEBOUNCE_MS`, `REPLAY_WRITER_DRAIN_TIMEOUT_MS`, `REPLAY_FAILURE_BACKOFF_MS`, `REPLAY_TRANSACTION_TIMEOUT_MS`.
- Проверка на отдельной копии `tmp/server_snapshot_20260716/replay-atomic-validation-20260717.db`: 338085 host + 28719 RTK обработаны за 68 секунд; результат 120 замесов, 743 компонента, 305 нарушений, raw-счётчики неизменны, `quick_check = ok`. Запуск тестов: `npm run test:replay-safety` плюс шесть существующих наборов.
- Исправление `3d81d67` развёрнуто в production. После деплоя `RTK_BUFFER_REPLAY_ENABLED=1` возвращён, quiet window явно установлен в 1800000 мс, writer drain — 60000 мс, transaction timeout — 1800000 мс; `DATA_RETENTION_ENABLED=false` сохранён. Старый host-буфер движется примерно на 72 секунды исходной истории за 13 минут реального времени, поэтому полный replay автоматически откладывается каждым старым пакетом до настоящего 30-минутного quiet window.
- После деплоя RTK inbox разгружен (`pending/retry/processing = 0`), защищённые API отвечают примерно за 5–12 мс, новых nginx `504` и новых записей `P1008/P2028` в PM2 error log не обнаружено. Production health показывает `calculatedReplay.state=idle`, `queued=true` при наличии старого буфера и открытый writer admission.

## Durable host ingress — локальная реализация 2026-07-17

- Host POST больше не выполняет тяжёлую Prisma-транзакцию до ответа: одиночный и batch endpoint сначала синхронно пишут в `server/runtime/host-ingress.sqlite3` (WAL, `synchronous=FULL`) и возвращают HTTP 202.
- Batch v1 принимает до 50 пакетов, `stream_id`, `live_packet_id` и `packet_id`; миграция `20260717000100_add_host_source_identity` добавляет постоянную idempotency-уникальность в `Telemetry`.
- Host worker обрабатывает live-записи раньше backlog. Старые записи только обновляют `historyDirtyFrom`; автоматический полный replay на каждый пакет удалён.
- `TelemetryWriteCoordinator` допускает максимум одного host/RTK-писателя. `/api/health` содержит `hostIngress` и безопасные счётчики очереди.
- На копии снимка 2026-07-17 принято 5200 пакетов: HTTP p95 21.8 мс, процесс остался жив, SQLite `integrity_check=ok`. Production rollout ещё требует отдельного backup/deploy шага.
- После первого production drain добавлен fast path для out-of-order host-пакетов: они проходят idempotency, базовую проверку и raw-вставку без геозон, FSM и постпроцессинга. Локальная очередь после live-приоритета обрабатывает около 11 исторических пакетов/с вместо примерно 3/с.
