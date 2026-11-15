# Задачи

## MVP локального worker

- [x] Диагностика Node/Git/Codex/login в Linux и безопасный поиск Windows native executables, без вывода авторизационного ответа.
- [x] Очередь и журнал задачи.
- [x] Ограниченная рабочая папка и timeout.
- [x] Структурированный финальный отчёт и классификация `blocked`.
- [x] `.cmd` launcher для bundled Node из Codex Desktop.
- [x] Испытать реальное изменение файла через `.\agent.cmd smoke`: пользователь подтвердил `Smoke PASS`, задача `0b7edf0d-5920-4d51-8a17-f4f0c80b6567`, completed, 2026-11-15.
- [x] Подтвердить на ПК пользователя запуск native Codex CLI `0.168.0` по полному пути и существующую авторизацию ChatGPT.
- [x] Проверить checkpoint ID сессии, recover/resume, защиту от старого отчёта, одновременный запуск и POSIX tree kill на имитаторе CLI.
- [ ] Проверить те же сценарии с настоящим Codex на Windows, включая границы sandbox.

## Облачная среда

- [x] Подключить GitHub repositories к Codex Cloud; обе рабочие копии доступны.
- [x] Подготовить/publish environment через desktop/web UI — публикацию подтвердил пользователь; восстановленный терминал проверен.
- [x] Проверить cloud task с Windows runner/CI: запуск `43706317987`, Linux и Windows — success.
- [ ] Проверить использование и продолжение той же задачи с mobile.
- [x] Подготовить минимальный GitHub Actions Linux/Windows workflow с JUnit artifact.
- [x] С разрешения пользователя отправить `cloud/agent-reliability` и получить реальные результаты CI для `451e0c5`.
- [ ] Записать квоты и ограничения текущего плана.

## Развитие

- [ ] Определить, нужна ли своя очередь/Agent Chat поверх Codex Cloud.
- [ ] Подключить безопасный локальный worker только для задач Windows/GUI.
- [ ] Автоматическая синхронизация и retry policy только после threat-model и устойчивых API.
