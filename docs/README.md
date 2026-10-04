# Документация site_korovki

Актуальное рабочее состояние сервера и сайта описывают следующие документы:

- [`server-platform/OPERATIONS.md`](server-platform/OPERATIONS.md) — установка, обновление, резервирование и откат production PostgreSQL;
- [`server-platform/MIGRATION-STATUS.md`](server-platform/MIGRATION-STATUS.md) — фактическое состояние серверной платформы и выпуски;
- [`server-platform/LOCAL-REALTIME-20261001.md`](server-platform/LOCAL-REALTIME-20261001.md) — realtime-расчёт замесов, независимая проверка веса, нарушения и локальная приёмка;
- [`server-platform/LOCAL-UPDATE-20261004.md`](server-platform/LOCAL-UPDATE-20261004.md) — актуальная локальная база, мобильные правки и блок планшета на главной;
- [`server-platform/RELEASE-20261002.md`](server-platform/RELEASE-20261002.md) — состав и проверки realtime-релиза;
- [`server-platform/BATCH-PACKET-WEIGHT-20260929.md`](server-platform/BATCH-PACKET-WEIGHT-20260929.md) — источник веса и границы планшетных шагов;
- [`../server/docs/loader-tasks.md`](../server/docs/loader-tasks.md) и [`../server/docs/loader-terminals.md`](../server/docs/loader-terminals.md) — контракт заданий и терминалов планшета.

Архитектурные решения и незавершённые этапы масштабирования находятся в [`server-platform/ARCHITECTURE.md`](server-platform/ARCHITECTURE.md), [`server-platform/PLAN.md`](server-platform/PLAN.md) и [`server-platform/DATABASE-ISOLATION.md`](server-platform/DATABASE-ISOLATION.md). PostgreSQL-переход уже завершён; первоначальные оценки и варианты в этих документах сохранены как история и помечены соответствующим образом.

Документы `LOCAL-SNAPSHOT-*`, `DEPLOY-*`, `STAGE1-HISTORY.md` и `history/WORKLOG-2026-07-08.md` фиксируют конкретные снимки, выпуски и прошлые проверки. Их команды нельзя применять как текущую конфигурацию без сверки с `OPERATIONS.md` и корневым `AGENTS.md`.

Секреты, рабочие дампы, логи, лаборатории и приватные данные терминалов хранятся вне Git.
