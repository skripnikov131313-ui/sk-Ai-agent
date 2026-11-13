# Задачи

## MVP локального worker

- [x] Диагностика Node/Git/Codex/login без вывода секрета.
- [x] Очередь и журнал задачи.
- [x] Ограниченная рабочая папка и timeout.
- [x] Структурированный финальный отчёт и классификация `blocked`.
- [x] `.cmd` launcher для bundled Node из Codex Desktop.
- [ ] Испытать реальное изменение файла в обычном локальном Codex контексте.
- [ ] Проверить restart/resume и tree kill после timeout.

## Облачная среда

- [ ] Подключить GitHub repositories к Codex Cloud.
- [ ] Подготовить/publish environment через desktop/web UI.
- [ ] Проверить cloud task с Windows runner/CI и использование с mobile.
- [ ] Создать минимальный GitHub Actions Windows workflow после подключения репозитория.
- [ ] Записать квоты и ограничения текущего плана.

## Развитие

- [ ] Определить, нужна ли своя очередь/Agent Chat поверх Codex Cloud.
- [ ] Подключить безопасный локальный worker только для задач Windows/GUI.
- [ ] Автоматическая синхронизация и retry policy только после threat-model и устойчивых API.
