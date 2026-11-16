"""Optional real-browser check; the executor is a local fixture, not a model.

python3 test/ui-browser.py --browser /usr/bin/chromium --output /workspace/artifacts/agent-ui
Requires an existing Playwright installation. Node-only CI does not install it.
"""
import argparse
import json
from pathlib import Path
from queue import Queue
import shutil
import subprocess
import tempfile
from threading import Thread

from playwright.sync_api import sync_playwright, expect


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser")
    parser.add_argument("--output")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    parent = repo / ".skai-agent" / "test-tmp"
    parent.mkdir(parents=True, exist_ok=True)
    base = Path(tempfile.mkdtemp(prefix="ui-browser-", dir=parent)).resolve()
    root = base / "agent"
    browser_root = base / "browser"
    root.mkdir()
    browser_root.mkdir()
    output = Path(args.output).resolve() if args.output else None
    if output:
        output.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen([shutil.which("node"), str(repo / "test/fixtures/ui-demo.mjs"), str(root), str(browser_root)],
                               cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    ready = Queue()
    Thread(target=lambda: ready.put(process.stdout.readline()), daemon=True).start()
    try:
        origin = json.loads(ready.get(timeout=10))["origin"]
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(**({"executable_path": args.browser} if args.browser else {}))
            context = browser.new_context(viewport={"width": 1280, "height": 1000}, timezone_id="Europe/Moscow", reduced_motion="reduce")
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(origin)
            expect(page.locator("#connection-label")).to_have_text("Очередь на связи")

            def add(goal):
                page.locator("#goal").fill(goal)
                page.locator("#add-task").click()
                expect(page.locator("#goal")).to_have_value("")

            def lose_acknowledgement(route):
                route.fetch()  # The server persists the task, then the client loses its acknowledgement.
                route.abort("failed")

            page.route("**/api/tasks", lose_acknowledgement)
            first = 'Тест интерфейса: <img src=x onerror="window.uiInjected=true"> отображается как текст'
            page.locator("#goal").fill(first)
            page.locator("#add-task").click()
            expect(page.locator("#notice")).to_have_class("error")
            page.unroute("**/api/tasks", lose_acknowledgement)
            page.reload()
            expect(page.locator("#goal")).to_have_value(first)
            add("Тест интерфейса: следующая задача запускается автоматически")
            expect(page.locator("#stat-queued")).to_have_text("2")
            assert page.locator("#task-list img").count() == 0
            assert page.evaluate("window.uiInjected === undefined")
            page.locator("#run").click()
            expect(page.locator("#stat-completed")).to_have_text("2", timeout=15000)
            assert (root / "fixture-result.txt").read_text() == "protocol fixture changed this file\n"
            page.locator(".task").first.click()
            expect(page.locator("#details")).to_be_visible()
            expect(page.locator("#detail-summary")).to_contain_text("Модель не вызывалась")
            expect(page.locator("#detail-checks")).to_contain_text("fixture ran")
            page.keyboard.press("Escape")
            expect(page.locator("#details")).not_to_be_visible()

            page.locator("#target").select_option("windows-gui")
            page.reload()
            expect(page.locator("#target")).to_have_value("windows-gui")
            add("Тест маршрутизации: окно ожидает Windows с рабочим столом")
            waiting_card = page.locator(".task").filter(has_text="окно ожидает Windows")
            expect(waiting_card).to_contain_text("Задаче нужен Windows")
            expect(waiting_card).to_contain_text("Попыток: 0/3")
            expect(page.locator("#run")).to_be_disabled()
            windows_id = waiting_card.get_attribute("data-task-id")
            page.locator("#target").select_option("current")
            page.locator("#dependency").select_option(windows_id)
            page.locator("#goal").fill("Тест маршрутизации: проверить результат окна")
            page.reload()
            expect(page.locator("#dependency")).to_have_value(windows_id)
            add("Тест маршрутизации: проверить результат окна")
            expect(page.locator("#run")).to_be_disabled()
            add("Тест маршрутизации: независимая подготовка данных")
            parent_id = page.locator(".task").filter(has_text="независимая подготовка").get_attribute("data-task-id")
            page.locator("#dependency").select_option(parent_id)
            add("Тест маршрутизации: следующий шаг после подготовки")
            page.locator("#run").click()
            expect(page.locator("#stat-completed")).to_have_text("4", timeout=15000)
            expect(page.locator("#stat-queued")).to_have_text("2")
            expect(waiting_card).to_contain_text("Попыток: 0/3")
            waiting_card.click()
            expect(page.locator("#detail-requirements")).to_contain_text("Windows с рабочим столом")
            expect(page.locator("#detail-error")).to_contain_text("Задаче нужен Windows")
            page.keyboard.press("Escape")

            draft = "Тест: черновик переживает перезагрузку страницы"
            page.locator("#goal").fill(draft)
            page.reload()
            expect(page.locator("#goal")).to_have_value(draft)
            add("Тест интерфейса: показать блокер FIXTURE_BLOCKED")
            add("Тест интерфейса: задача после блокера остаётся в очереди")
            page.locator("#run").click()
            expect(page.locator("#stat-attention")).to_have_text("1", timeout=15000)
            expect(page.locator("#stat-queued")).to_have_text("3")
            if output:
                page.screenshot(path=str(output / "agent-ui-desktop.png"), full_page=True)
            page.set_viewport_size({"width": 390, "height": 844})
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            if output:
                page.screenshot(path=str(output / "agent-ui-mobile.png"), full_page=True)
            page.locator(".task").filter(has_text="FIXTURE_BLOCKED").click()
            expect(page.locator("#details")).to_be_visible()
            expect(page.locator("#detail-blockers")).to_contain_text("synthetic blocker")
            box = page.locator("#details").bounding_box()
            assert box["x"] >= 0 and box["width"] <= 390
            page.get_by_role("button", name="Закрыть сведения").click()
            page.get_by_role("button", name="Рабочий план").click()
            expect(page.locator("#composer")).not_to_be_visible()
            page.get_by_role("button", name="Память").click()
            expect(page.locator("#memory-panel")).to_be_visible()
            expect(page.locator("#memory-lessons article")).to_have_count(4)
            expect(page.locator("#memory-preferences")).to_contain_text("Не сообщай отдельно")
            expect(page.locator("#memory-metrics strong").nth(0)).to_have_text("8")
            expect(page.locator("#memory-metrics strong").nth(1)).to_have_text("4")
            expect(page.locator("#memory-metrics strong").nth(3)).to_have_text("0")
            assert page.locator("#memory-lessons img").count() == 0
            assert page.evaluate("window.memoryInjected === undefined")
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            if output:
                page.screenshot(path=str(output / "agent-memory-mobile.png"), full_page=True)
            page.set_viewport_size({"width": 1280, "height": 1000})
            if output:
                page.screenshot(path=str(output / "agent-memory-desktop.png"), full_page=True)
            page.get_by_role("button", name="Мои задачи").click()
            expect(page.locator("#composer")).to_be_visible()
            expect(page.locator("#stat-completed")).to_have_text("4")

            agent_draft = "Черновик Agent сохраняет собственную среду и зависимость"
            browser_draft = "Черновик Browser не попадает в очередь Agent"
            page.locator("#target").select_option("windows-gui")
            page.locator("#dependency").select_option(windows_id)
            page.locator("#goal").fill(agent_draft)
            page.locator("#project-select").select_option("browser")
            expect(page.locator("#goal")).to_have_value("")
            expect(page.locator("#target")).to_have_value("current")
            expect(page.locator("#dependency")).to_have_value("")
            expect(page.locator("#queue-count")).to_have_text("0")
            browser_goal = "Задание Browser сохраняется один раз после потери подтверждения"
            page.route("**/api/tasks", lose_acknowledgement)
            page.locator("#goal").fill(browser_goal)
            page.locator("#add-task").click()
            expect(page.locator("#notice")).to_have_class("error")
            page.unroute("**/api/tasks", lose_acknowledgement)
            page.reload()
            expect(page.locator("#project-select")).to_have_value("browser")
            expect(page.locator("#goal")).to_have_value(browser_goal)
            add(browser_goal)
            expect(page.locator("#queue-count")).to_have_text("1")
            page.locator("#run").click()
            expect(page.locator("#stat-completed")).to_have_text("1", timeout=15000)
            assert (browser_root / "fixture-result.txt").exists()
            assert not (browser_root / ".skai-agent").exists()
            page.locator("#goal").fill(browser_draft)
            page.locator("#project-select").select_option("agent")
            expect(page.locator("#goal")).to_have_value(agent_draft)
            expect(page.locator("#target")).to_have_value("windows-gui")
            expect(page.locator("#dependency")).to_have_value(windows_id)
            expect(page.locator("#queue-count")).to_have_text("8")
            page.locator("#project-select").select_option("browser")
            expect(page.locator("#goal")).to_have_value(browser_draft)
            page.get_by_role("button", name="Память").click()
            expect(page.locator("#memory-lessons article")).to_have_count(0)
            expect(page.locator("#memory-empty")).to_be_visible()
            expect(page.locator("#memory-metrics strong").nth(0)).to_have_text("1")
            page.get_by_role("button", name="Мои задачи").click()

            held = []

            def hold_agent_state(route):
                if route.request.headers.get("x-skai-project") == "agent" and not held:
                    response = route.fetch()
                    data = response.json()
                    data["tasks"][0]["goal"] = "SYNTHETIC_OLD_PROJECT_TASK"
                    held.append((route, response, data))
                else:
                    route.continue_()

            page.route("**/api/state", hold_agent_state)
            page.locator("#project-select").select_option("agent")
            for _ in range(200):
                if held:
                    break
                page.wait_for_timeout(25)
            assert held, "The delayed Agent response must be captured"
            page.locator("#project-select").select_option("browser")
            page.evaluate("""() => {
              window.oldProjectRendered = false;
              new MutationObserver(() => {
                if (document.querySelector('#task-list').textContent.includes('SYNTHETIC_OLD_PROJECT_TASK')) window.oldProjectRendered = true;
              }).observe(document.querySelector('#task-list'), {childList:true, subtree:true, characterData:true});
            }""")
            held[0][0].fulfill(response=held[0][1], json=held[0][2])
            expect(page.locator("#queue-count")).to_have_text("1")
            expect(page.locator(".task")).to_have_count(1)
            expect(page.locator(".task")).to_contain_text(browser_goal)
            assert page.evaluate("window.oldProjectRendered === false")
            page.unroute("**/api/state", hold_agent_state)
            page.reload()
            expect(page.locator("#goal")).to_have_value(browser_draft)
            page.evaluate("sessionStorage.setItem('skai-project-scope', 'stale-scope')")
            page.reload()
            expect(page.locator("#goal")).to_be_disabled()
            expect(page.locator("#notice")).to_contain_text("привязка изменилась")
            page.locator("#project-select").select_option("browser")
            expect(page.locator("#goal")).to_have_value(browser_draft)
            expect(page.locator("#queue-count")).to_have_text("1")
            page.set_viewport_size({"width": 390, "height": 844})
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            if output:
                page.screenshot(path=str(output / "agent-projects-mobile.png"), full_page=True)
            page.set_viewport_size({"width": 1280, "height": 1000})
            if output:
                page.screenshot(path=str(output / "agent-projects-desktop.png"), full_page=True)
            assert not errors, errors
            browser.close()
        print("PASS: Chromium desktop/mobile, separate project queues/memory/drafts, lost acknowledgement, stale selection/response, routing, dependencies, reports, blockers and escaped content. Executor: fixture; no model calls.")
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        shutil.rmtree(base)


if __name__ == "__main__":
    main()
