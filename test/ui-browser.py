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
    root = Path(tempfile.mkdtemp(prefix="ui-browser-", dir=parent)).resolve()
    output = Path(args.output).resolve() if args.output else None
    if output:
        output.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen([shutil.which("node"), str(repo / "test/fixtures/ui-demo.mjs"), str(root)],
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

            draft = "Тест: черновик переживает перезагрузку страницы"
            page.locator("#goal").fill(draft)
            page.reload()
            expect(page.locator("#goal")).to_have_value(draft)
            add("Тест интерфейса: показать блокер FIXTURE_BLOCKED")
            add("Тест интерфейса: задача после блокера остаётся в очереди")
            page.locator("#run").click()
            expect(page.locator("#stat-attention")).to_have_text("1", timeout=15000)
            expect(page.locator("#stat-queued")).to_have_text("1")
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
            assert not errors, errors
            browser.close()
        print("PASS: Chromium desktop/mobile, queue execution, reports, blockers, draft persistence and escaped task content. Executor: fixture; no model calls.")
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        shutil.rmtree(root)


if __name__ == "__main__":
    main()
