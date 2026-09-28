# Отдельный старт компонентов (28.09.2026)

Новые Android-клиенты передают explicitStepStart=true в begin/confirm. Reducer сохраняет режим в state; confirm увеличивает currentIndex без переноса baseline на следующий шаг. active без baseline означает ожидание начала текущего компонента. begin разрешён для ready или такого ожидания и фиксирует текущий вес. Порядок компонентов фиксирован, пропуск индекса запрещён.

Legacy-события сохраняют прежнее поведение, пока флаг не включён. Новая версия может завершить уже начатый старый компонент, сохранив его исходный baseline. Хранилища SQLite и PostgreSQL используют общий reducer; изменения схемы не нужны.

Проверки: node scripts/loader-component-start-test.mjs и node scripts/loader-tasks-test.mjs. Оба сценария работают с изолированной SQLite, не с production-БД. Первый проверяет вес между шагами, запрет confirm до begin, undo, повтор ID и сохранение состояния.

Production: модуль обновлён в releases/20260926-with-tablet/server; исходный файл сохранён в /opt/backups/farm-site/component-start-dPzqGOK9. PM2 farm-server-tablet перезапущен, health=ok. Тесты прошли на сервере до перезапуска. Распространять APK 0.7.7 после серверного обновления.
