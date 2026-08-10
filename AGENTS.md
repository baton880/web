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
- Host worker не делает 100-мс паузу между успешно claimed строками: при наличии backlog следующий tick запускается сразу, а пустой/занятый inbox по-прежнему опрашивается с обычной задержкой.

## Свежий локальный снимок и replay 2026-07-17

- Актуальный согласованный снимок production SQLite сохранён как `C:\Users\Windows\projects\tmp\server_snapshot_20260717\server-dev.db`; SHA-256: `64821eb2c32c40b6adbd278f20b9caaf57c45710087bf97f4da979e7a8a62686`.
- Рабочая копия после полного replay: `C:\Users\Windows\projects\tmp\server_snapshot_20260717\replay-dev.db`. Raw-данные сохранены: 430266 `Telemetry` и 47477 `RtkTelemetry`; `integrity_check = ok`.
- Локальный сайт запущен на `http://127.0.0.1:3000` с этой рабочей копией, `DATA_RETENTION_ENABLED=false` и `RTK_BUFFER_REPLAY_ENABLED=0`.

## Диагностика RTK replay и свежий снимок 2026-07-18

- Production оставался физически исправен: nginx и PM2 online, основная SQLite прошла `quick_check` и `integrity_check`. Автоматический replay шёл с `2026-07-18T03:54:15Z` до `03:56:55Z`; в этом окне в последних nginx-логах не было `504`, только четыре клиентских `499`.
- Replay запустил RTK, а не host: после короткого сетевого провала RTK прислал multi-packet buffer-пачки. Последняя пачка из 7 строк пришла `2026-07-18T03:53:45.787Z` с `buffer_remaining_after_ack=0`, после чего scheduler применил 30-секундный drained debounce и пересчитал всю историю. Текущая логика `processRtkTelemetryBody()` ставит полный replay для любого созданного multi-packet RTK-запроса; даже хвост порядка 30–100 секунд может вызвать пересчёт сотен тысяч host-строк. Это отдельный кандидат на исправление: replay должен требовать существенно исторические RTK-данные или более длинное quiet window.
- Production history API исправны, но ответы велики: limit 20000 отдаёт примерно 14.8 MB host и 25.0 MB RTK. На production это заняло около 0.9 и 2.8 секунды, после чего браузер production-версии создаёт много отдельных объектов карты. Незакоммиченная локальная правка `frontend/js/dashboard.js` объединяет непрерывные RTK-точки в полилинии и пока не развёрнута.
- Консистентный snapshot расположен в `C:\Users\Windows\projects\tmp\incident-20260718T043410Z`: `server-dev.db`, `host-ingress.sqlite3`, `rtk-ingress.sqlite3`, RTK dead-letter и хвосты PM2/nginx. SHA-256 основной БД: `2498106e0eef63d2876e13f20f2cd727156b8d9cdaeb4e328bb8fb7751104c36`.
- Snapshot содержит 456890 `Telemetry`, 60159 `RtkTelemetry`, 134 `Batch`, 836 `BatchIngredient`, 367 `Violation`. Полный replay текущим локальным working tree обработал все 456890 строк и выполнил postprocessing 134 замесов: результат 134 `Batch`, 844 `BatchIngredient`, 369 `Violation`, 0 открытых замесов; raw-счётчики не изменились, `quick_check=ok`.
- Локальный сайт запущен на `http://127.0.0.1:3000` с `replay-dev.db`, отдельными копиями ingress-БД, `DATA_RETENTION_ENABLED=false` и `RTK_BUFFER_REPLAY_ENABLED=0`. Не использовать snapshot-оригиналы как рабочие БД.
- В RTK inbox зафиксировано 9 permanent-запросов с синтаксически битым JSON вида `{"items":]...}`; валидные соседние пакеты обработаны. На момент финальной проверки host был актуален, а последний RTK timestamp был `2026-07-18T03:56:46Z`.

## Актуальный snapshot и утренние пропуски замесов 2026-07-18

- Согласованный production snapshot на `2026-07-18 12:37:33 +07` расположен в `C:\Users\Windows\projects\tmp\current-20260718T053733Z`. Оригинал основной БД — `server-dev.db`, рабочая копия — `replay-dev.db`; также сохранены отдельные host/RTK ingress SQLite и RTK dead-letter. SHA-256 `server-dev.db`: `ca0612b1ff0a95d7aedb3d6d6eae9feaf19ede07b6c47e50676b579a9cb2e041`.
- Полный replay рабочей копии обработал 458758 `Telemetry` и 60159 `RtkTelemetry`; postprocessing выполнен для 134/134 замесов. Результат: 134 `Batch`, 844 `BatchIngredient`, 369 `Violation`, 0 открытых замесов; `quick_check` и `integrity_check` — `ok`, raw-счётчики сохранены.
- Локальный сайт на `http://127.0.0.1:3000` использует `replay-dev.db`, отдельные рабочие копии ingress-БД, `DATA_RETENTION_ENABLED=false` и `RTK_BUFFER_REPLAY_ENABLED=0`.
- В интервале `2026-07-18 06:00–08:30 +07` host-телеметрия не пропадала: 4422 непрерывных пакета. Вес показывает минимум два полных цикла загрузки/выгрузки примерно `07:24–07:48` и `07:52–08:26`.
- Целевой контракт старта — HOST-first: замес начинается по росту веса хозяина, только если координата HOST находится внутри loading zone либо не далее 20 м от её границы. RTK погрузчика не должен разрешать или запрещать первичный `START_BATCH`; он нужен для postprocessing и более точной раскладки компонентов.
- В raw-данных двух утренних циклов HOST не прошёл именно host-zone проверку. В `07:23:36` координата `52.42718505, 85.70213853` находилась в 418.6 м от ближайшей loading zone «Люцерна»; в `07:51:22` — в 419.9 м. За оба цикла было 0 HOST-пакетов в зоне или в пределах 20 м от её границы. Ближе всего HOST подошёл только в `08:22:46`: 20.61 м до «Комбикорм», всё ещё чуть за порогом. Поэтому по целевому HOST-first правилу эти циклы не могли открыть замес; нужно выяснять расхождение фактического положения техники с записанным GPS/геометрией зон.
- Replay сейчас всё ещё подменяет координаты входного `processPacket()` на `effectivePosition` и разрешает RTK scoreboard в зависимости от расстояния до погрузчика. Это нарушает HOST-first контракт и может позволить RTK влиять на границы замеса; первичную FSM следует кормить HOST-координатами, а RTK оставить postprocessing-слою.
- Контрольный replay `replay-distance700.db` восстановил циклы `07:23:36–07:47:24` и `07:51:22–08:24:30` только потому, что большой радиус позволил RTK погрузчика управлять первичной FSM. Этот эксперимент не подтверждает правильность таких замесов по HOST-first правилу и не является допустимым исправлением; он показал опасную зависимость старта от RTK. Результат также исказил другие данные: 134 -> 136 замесов и 369 -> 425 нарушений.
- Скачанный журнал малины покрывает только `10:40–11:10 +07`, не утренний интервал. В нём все POST получили HTTP 202, очереди оставались около нуля, ошибок и перезапусков нет; этот файл не доказывает состояние устройства в 06:00–08:26.
- Полный журнал малины `C:\Users\Windows\host-monitor-morning-0718.txt` покрывает `06:00–08:35 +07`. В нём 4568 успешных HTTP 202, GPS-reader без ошибок и без потери fix, telemetry buffer не накапливался. Два read timeout в `08:17:38` и `08:19:55` были штатно повторены через 1–2 секунды пачками по две строки (`acked=2`, `remaining=0`), поэтому потерь не вызвали. В status-срезах вес был `None` до `06:39:44`, после чего работал; нужные циклы `07:23–07:47` и `07:51–08:24` к этому не относятся.
- Фактический HOST-first старт: HOST находится в loading zone или в 20 м от её границы, прирост веса от baseline строго больше первого порога и есть два подтверждающих пакета. При production `batchStartThresholdKg=25` первый эффективный порог равен `25 + max(5, 15%) = 30 кг`, то есть нужен прирост `>30 кг`. `START_BATCH` записывается при последующем flush подтверждённого сегмента и может получить ретроспективное время начала. RTK не должен входить в эти условия.
- Для пропущенных утренних циклов рост веса был, но HOST-зона отсутствовала: `hasCandidateLoadingContext=false`, кандидат очищался, baseline сдвигался вслед за ростом и `loadingStartTimeMs` не подтверждался. Причина по данным — записанная позиция HOST далеко от текущей геометрии loading zones, а не дальность погрузчика.
- Для устойчивого локального запуска на 3000 используется `C:\Users\Windows\projects\tmp\current-20260718T053733Z\start-local-site-3000.cmd`. Он запускается независимым Windows-процессом, иначе node-процесс, созданный обычной служебной exec-сессией Codex, может завершиться вместе с этой сессией. Логи: `local-site-3000.out.log` и `local-site-3000.err.log` в том же каталоге.
- Во время финальной проверки RTK buffer снова запустил production replay: `2026-07-18 12:46:01–12:48:47 +07`. Сайт и `/api/health` всё время отвечали HTTP 200; writer admission штатно закрывался, durable-очереди выросли максимум минимум до наблюдавшихся 80 host / 148 RTK, затем автоматически разгрузились до `host pending/retry=0`, `RTK pending/retry=0`. Replay вернулся в `idle`, admission открылся, `lastError` пуст; 9 старых permanent RTK-запросов остались теми же битым JSON и не увеличились.

## Пошаговый просмотр общей карты 2026-07-18

- На главной странице для ADMIN добавлен таймлайн по истории HOST. Один кадр соответствует одному host-пакету; карта показывает координату HOST, вес и host-зону, а рядом — последний известный к этому времени RTK-пакет погрузчика, его зону и возраст относительно HOST.
- При ручной промотке или воспроизведении live polling продолжает работать, но не перетирает исторические позиции маркеров. Кнопка «К текущему» завершает просмотр и возвращает актуальные HOST/RTK-позиции.
- Проверено в локальном браузере на `replay-dev.db`: 17001 кадр от `03:00:56` до `12:37:32 +07`, ползунок, пуск/пауза и возврат к текущему пакету работают; ошибок JavaScript нет. Панель скрыта для пользователей без роли ADMIN.

## Исправление задержки текущего HOST/GPS — локально 2026-07-18

- Причина задержки до 1 ч 20 мин: каждый входящий batch оставлял одну строку `is_live=1`, а host worker выбирал все такие строки по старому `id`. При большом Pi-backlog сервер последовательно показывал «live» из прошлых batch. Вес и координаты в raw history сохранялись с исходными timestamps, поэтому timeline веса мог выглядеть правильно при отстающей текущей карте.
- Host inbox теперь при старте и при каждом новом batch оставляет один самый новый ready-live на устройство; внутри durable stream запоздавший меньший `packet_id` не может его заменить. Проверка на 7000 строк выбирает packet 7000 первым и не удаляет историю.
- Добавлена `DeviceCurrentTelemetry`: `/host/current` читает отдельный указатель live-пакета, поэтому последующая запись старого backlog не двигает текущую карту назад. Миграция `20260718000100_add_host_current_and_gps_age` также добавляет `Telemetry.gpsAgeS`.
- Карта HOST не использует координаты при `gpsValid=false` или `gpsAgeS > 3`; вес продолжает обновляться независимо. Старые ответы без `gpsAgeS` остаются совместимыми.
- Проверено локально: `npm run test:host-ingress`, `npm run test:host-current`, `prisma validate`, JS syntax check; миграция применена к рабочей `replay-dev.db`, перед этим создана `replay-dev-before-gps-current-20260718.db`. Локальный health на 3000 отвечает HTTP 200. Production rollout и обновление Raspberry Pi ещё не выполнялись.

## Свежий production snapshot и локальный replay 2026-07-26

- Локальный `HEAD`, GitHub `origin/main` и production совпадают на `5192e9f`; незакоммиченные локальные изменения сохранены без перезаписи.
- Согласованные SQLite-снимки production находятся в `C:\Users\Windows\projects\tmp\server_snapshot_20260726_180000`: `server-dev.db`, `host-ingress.sqlite3`, `rtk-ingress.sqlite3` и RTK dead-letter. SHA-256 скачанных файлов совпали с сервером, все SQLite прошли `integrity_check = ok`.
- На отдельную `replay-dev.db` применена миграция `20260718000100_add_host_current_and_gps_age`, затем выполнен полный replay 672493 HOST-пакетов: 158 замесов, 1029 ингредиентов, 412 нарушений, 0 открытых замесов. Raw `Telemetry` (672493) и `RtkTelemetry` (82782), включая временные диапазоны, не изменились.
- Локальный сайт запущен независимым процессом на `http://127.0.0.1:3000` через `start-local-site-3000.cmd` из каталога снимка; `DATA_RETENTION_ENABLED=false`, `RTK_BUFFER_REPLAY_ENABLED=0`. `/api/health` и `/` отвечают HTTP 200, stderr пуст.

## Локальные исправления интерфейса 2026-07-26

- Режим слежения за HOST/RTK больше не выключается при временной потере координат: выбранная цель сохраняется, кнопка показывает ожидание и слежение автоматически возобновляется после появления валидного GPS. Проверено в браузере принудительным `gpsAgeS=10` с последующим точным восстановлением исходной строки.
- Для роли DIRECTOR пункт «Нарушения» скрыт в боковом и мобильном меню. Прямой доступ к странице и API не менялся.
- В активной «Сводке по технике» удалены преждевременные план, отклонение и нарушение; показываются только фактически зафиксированные компоненты.
- В список завершённых замесов добавлен `totalActualWeight` — сумма фактических весов компонентов, совпадающая с итогом «Факт» внутри замеса. На мобильном экране строки превращаются в читаемые карточки без горизонтальной прокрутки.
- Текущий вес на главной намеренно не менялся: это мгновенное показание весов, тогда как итог замеса складывается из детектированных ступенек загрузки. Рекомендуемый следующий шаг — явно подписать его «Вес на весах сейчас» и рядом отдельно показывать «Загружено в текущем замесе».
- Администраторский таймлайн общей карты теперь позволяет выбрать конкретный календарный день. Сервер возвращает ограниченную этим днём историю HOST/RTK, пересекающиеся замесы, компоненты и необходимые пороги настроек одним replay-ответом; список доступных дней строится по реально имеющимся HOST-пакетам.
- При перемотке исторический кадр применяется ко всей сводке главной страницы: меняются статус, зона, режим работы, вес, активный замес, уже загруженные компоненты, технические предупреждения и прогресс выгрузки. Кнопка «К текущему» полностью возвращает live-состояние.
- Проверено в браузере на дне `2026-07-23`: загружены 40137 HOST-кадров, 6087 RTK-пакетов и 8 замесов; у замеса №159 воспроизводятся загрузка, выгрузка и последующее ожидание, пуск/пауза и возврат в live работают без JavaScript-ошибок.

## Production-деплой 2026-07-26

- Перед деплоем создан согласованный SQLite-снимок `/opt/backups/farm-site/server-dev-before-deploy_20260726_124822.db` с SHA-256 и `integrity_check = ok`. Полный архив `/opt/backups/farm-site/farm-site-full_20260726_124827.tar.gz` прошёл проверку checksum и наличия проекта, `.env`, БД, frontend и nginx-конфигурации.
- Production обновлён строго fast-forward с `5192e9f` до `1f0f56b`; зависимости переустановлены через `npm ci`, Prisma schema и изменённые JS-файлы прошли syntax validation.
- Миграция `20260718000100_add_host_current_and_gps_age` сначала успешно проверена на отдельной копии production-БД, затем применена к production во время короткой остановки `farm-server`. Тесты `test:host-ingress`, `test:host-current`, `test:weight-boundary-stop` и `test:rest-plateau` прошли.
- После запуска PM2-приложение `farm-server` online, replay idle, writer admission открыт, host/RTK-очереди пусты, `DATA_RETENTION_ENABLED=false` сохранён. Локальный и публичный `/api/health` отвечают `status=ok`, публичная главная отдаёт новый выбор дня и версии dashboard-скриптов `20260726d`.
- Production SQLite после миграции прошла `integrity_check = ok`; raw-счётчики сохранились: 672493 `Telemetry` и 82782 `RtkTelemetry`. Вычисленные данные не перепрогонялись при деплое: 158 `Batch`, 1018 `BatchIngredient`, 404 `Violation`.
- `npm ci` сообщил о 7 известных audit-находках (1 low, 1 moderate, 5 high); автоматический `npm audit fix` намеренно не запускался, чтобы не менять зафиксированные зависимости в обход отдельной проверки.

## Локальное исправление calculated replay-loop 2026-08-10

- Production commit на момент диагностики: `1f0f56b`. Исправление подготовлено локально в ветке `fix/telemetry-day-replay-loop`; production, PM2 и production-БД в ходе работы не изменялись.
- Причина петли подтверждена регрессионным тестом: во время пяти минут full replay HOST ingress накапливал новые строки, после resume live-first делал хвост искусственно историческим и снова выставлял `historyDirtyFrom`.
- Host ingress теперь сохраняет конечный `replay_catchup_through_id` и после replay разбирает только зафиксированный хвост FIFO. Новые поступления не удлиняют fence бесконечно; interrupted replay восстанавливает catch-up при следующем открытии ingress-БД.
- Dirty-маркеры хранятся по календарным дням Бийска (`Asia/Barnaul`) с окном ±10 минут, источниками и version/CAS. Повторные сигналы коалесцируются, но `REPLAY_MAX_QUEUE_WAIT_MS` (по умолчанию 2 минуты) не позволяет постоянному потоку навсегда отложить запуск.
- Автоматический scheduler требует валидный `farmDay` и не может молча перейти к global replay. Дочернему процессу передаются `REPLAY_DAY`, `REPLAY_DIRTY_FROM` и `REPLAY_DIRTY_TO`.
- Day replay удаляет и пересоздаёт только замесы, пересекающие выбранный день. Для корректного состояния FSM он прогревается на одном предыдущем дне raw-телеметрии; временные результаты warm-up удаляются внутри той же транзакции. Пограничные замесы, которые нельзя полностью восстановить из доступного контекста, защищаются от удаления. Закрытые вручную нарушения и комментарии сохраняются.
- HOST `/current`, `/admin/latest` и `/admin/history`, а также RTK latest могут показывать самые новые принятые данные прямо из durable ingress, пока main writers приостановлены. Исторический HOST из другого stream больше не сдвигает `DeviceCurrentTelemetry` назад.
- RTK replay ставится только для действительно исторических пакетов относительно high-water mark того же устройства. Обычная последовательная multi-packet пачка replay не вызывает; одиночный поздний пакет вызывает. High-water разных погрузчиков не смешиваются.
- Основные тесты: `npm run test:replay-safety`, `test:host-ingress`, `test:rtk-ingress`, `test:host-current`, `test:rtk-current`, `test:day-replay`, `test:late-packet-replay`. `test:day-replay` требует `REPLAY_VALIDATION_DATABASE` и опционально `REPLAY_VALIDATION_DAY`; тест всегда работает с SQLite backup-копией.
- На snapshot `C:\Users\Windows\projects\tmp\server_snapshot_20260726_180000\replay-dev.db` прошли все 21 доступный день (2026-07-02..2026-07-23 с пропусками без замесов), включая пограничный 7–8 июля и state-sensitive 11 июля. Дифференциальный тест с инъекцией позднего пакета сравнил day replay с full replay текущего кода; raw HOST/RTK и строки других дней не изменились, `integrity_check = ok`.
