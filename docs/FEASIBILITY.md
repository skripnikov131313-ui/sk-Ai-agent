# Реализуемость автономного агента

Дата: 2026-11-13.

## Рекомендованный режим

Codex Cloud запускает кодовые задачи на управляемой OpenAI машине и поддерживает продолжение с desktop/web/mobile, в том числе когда локальный компьютер спит. Для нового Cloud UI нужно подготовить и опубликовать окружение с подключёнными репозиториями. В текущем Codex Cloud settings, проверенных ранее, окружение отображалось без repositories. Кодовые изменения нужно регулярно сохранять в Git; отдельные задачи не подхватывают автоматически незакоммиченные файлы другой задачи.

## Обычная подписка и API

Доступ к Codex в ChatGPT плане и биллинг OpenAI API — разные вещи. Cloud доступ зависит от плана/rollout; текущая диагностика показывала Plus, не исчерпанный лимит Codex и отсутствие отдельных API credits. Не строить облачный сервис, опираясь на пользовательский Plus как на общий API ключ.

## Локальная ошибка запуска

В терминале пользователя `node` не найден в PATH. Этот Codex Desktop установил Node только внутри каталога `WindowsApps\OpenAI.CodexPrimaryRuntime...\dependencies\node\bin`. `agent.cmd` ищет в этом пакете или в PATH, не устанавливает Node и не требует admin прав.

Отдельный blocker: вложенный `codex exec` запустился, но сообщил, что локальная команда не может быть запущена (`registered Core launch requires an installed app`). Smoke task поэтому имеет результат `blocked`; нельзя считать executor готовым.

## Источники

- [OpenAI Help: Using Codex Cloud](https://help.openai.com/en/articles/20001545-using-codex-cloud)
- [OpenAI Help: Codex plans and Cloud](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
- [OpenAI Developers: Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform)
