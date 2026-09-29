# Полная локальная копия PostgreSQL — 29 сентября 2026

Для дальнейших исправлений с реальной телеметрией скачана вся рабочая БД farm_main с VPS 13.143.128.140. SSH host key проверен по локальному known_hosts. Production не останавливался; данные не изменялись. На сервере создан только каталог backup.

## Источник и согласованность

- Рабочее приложение: PM2 farm-server-tablet, выпуск /opt/farm-platform/releases/20260926-with-tablet; прежний farm-server-ingress остановлен.
- Snapshot начат 2026-09-29 06:44:10 UTC (13:44:10 UTC+7), dump завершён 06:44:58 UTC.
- Счётчики и pg_dump сняты в одном экспортированном snapshot транзакции REPEATABLE READ READ ONLY. Включены все 24 таблицы public: бизнес-данные, raw HOST/RTK, пользователи, планшеты, задания, очереди, checkpoint и миграции.
- Серверный каталог: /opt/backups/farm-site/local-snapshot-20260929.
- Локальный каталог: C:/Users/Windows/projects/tmp/server-snapshot-20260929.
- farm.dump: 220814967 байт; SHA-256: 42adf3854ddd44eac168c709b450d6769458292193127a90b53604aecf2a7c3c. Хешы локального и серверного файлов совпали.
- Проверки: pg_restore --list, полное восстановление с --exit-on-error, совпадение количества строк во всех 24 таблицах, отсутствие невалидированных constraints. Результаты — manifest.json и restore-verification.json рядом с dump.

## Данные

| Таблица | Строк |
| --- | ---: |
| Telemetry | 2551413 |
| RtkTelemetry | 239520 |
| Batch | 272 |
| BatchIngredient | 1729 |
| Violation | 1499 |
| LoaderTerminal | 3 |
| LoaderTask | 22 |
| LoaderTaskEvent | 86 |
| host_ingress | 721719 |
| rtk_ingress | 371 |
| User | 4 |

HOST: 2026-07-01 20:22:25 — 2026-09-29 06:44:09 UTC. RTK: 2026-07-03 00:00:00.200 — 2026-09-28 00:37:10 UTC. У планшетов две действующие регистрации и одна отозванная. Показания не являются живым потоком после времени снимка.

## Локальная работа

Дополнительно 29 сентября скачано приватное состояние удалённого обслуживания из `server/private-terminal-remote` активного выпуска. Оно хранится вне PostgreSQL и получено позже SQL-снимка: времена heartbeat могут отличаться. В папке снимка `remote-original` содержит исходный JSON, `remote-working` — рабочую копию, на которую указывает `LOADER_REMOTE_DIR` в start-local.ps1. Восстановлены последний PNG, версия APK и статус команды. Локальная копия не связана с живым планшетом: новые команды исполнятся только устройством, подключённым к этому локальному серверу. В браузере проверены кнопки и загрузка PNG 1340×800; production-команды при проверке не отправлялись.

PostgreSQL 18.6 из официального portable-архива EDB (https://www.enterprisedb.com/download-postgresql-binaries), каталог pgsql. Отдельный кластер pgdata слушает только 127.0.0.1:55439; восстановленная БД farm_local_20260929. Dump сохраняется отдельно и неизменным.

Запуск сайта и при необходимости PostgreSQL:

```powershell
powershell.exe -NoProfile -File C:\Users\Windows\projects\tmp\server-snapshot-20260929\start-local.ps1
```

Сайт слушает http://127.0.0.1:3000. Используются отдельный локальный JWT_SECRET и пароль PostgreSQL из приватных файлов в tmp. Не копировать их в репозиторий. После сверки добавлена тестовая учётная запись local-review (теперь в рабочей копии 5 пользователей); исходные 4 не менялись. Логи сайта site.out.log/site.err.log, PostgreSQL postgres.log.

Фоновые workers, scheduled jobs, retention и replay отключены. На момент snapshot в HOST inbox одна pending запись, 28 dirty days; они сохраняются без автоматической обработки. Вызовы чтения планшетов не обновляют lastSeenAt. Любой будущий replay выполнять осознанно на рабочей копии, оригинальный dump не заменять.

Проверены HTTP 200 для health (main и ingress = postgres), списка трёх планшетов, HOST latest/history, RTK history и замесов. В браузере открыта вкладка «Планшеты» с реальными регистрациями. Проверка интерфейса пользователем проводится локально; commit/push после подтверждения, production deployment отдельно.
