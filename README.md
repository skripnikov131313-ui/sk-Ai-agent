# Sk/Ai Agent

Локальный ограниченный исполнитель задач на базе уже авторизованного Codex CLI. Для длительной работы с телефона и при выключенном ноутбуке основной маршрут — **Codex Cloud**, после публикации Cloud environment с репозиториями. Этот Agent не создаёт второй LLM runtime или API-биллинг.

## Локальная проверка

Если Node.js доступен в PATH:

```cmd
node src\cli.mjs doctor
node src\cli.mjs list
node --test test\*.test.mjs
```

Если Node есть только в составе Codex Desktop, из корня репозитория используйте:

```cmd
agent.cmd doctor
agent.cmd list
agent.cmd run <id>
```

Launcher ищет Node.js в PATH или в установленном пакете Codex Desktop, ничего не устанавливает и не меняет системные настройки. Путь к внутреннему runtime может меняться при обновлениях приложения.

## Текущие ограничения

- Задачи исполняются на этой машине; ноутбук должен быть включён.
- Успех принимается только по структурированному отчёту (`completed` / `blocked` / `failed`).
- Один запуск ограничен десятью минутами; повторы только вручную.
- Доступ Codex ограничен `workspace-write` репозитория.
- UI чата, Cloud API и автосинхронизация с мобильным устройством не реализованы.
- В текущем smoke-test второй Codex-процесс сообщил `registered Core launch requires an installed app`; он не прочитал тестовый файл. Смотрите `docs/FEASIBILITY.md`.
