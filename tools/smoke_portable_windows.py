"""Verify the real package with its bundled Node on Windows, without Codex calls."""
import argparse
import http.client
import json
import os
from pathlib import Path
from queue import Queue, Empty
import re
import shutil
import subprocess
import sys
import tempfile
import time
from threading import Thread
import zipfile

from package_portable import ROOT, TOP, VERSION, PackageError, verify_package


def smoke(archive, commit):
    if sys.platform != "win32":
        raise PackageError("This package execution check requires Windows.")
    report = verify_package(archive, commit)
    parent = ROOT / ".skai-agent" / "portable-check"
    parent.mkdir(parents=True, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix="package-", dir=parent))
    process = None
    try:
        unpacked = directory / "folder with spaces & tools"
        # Every member was checked before extraction; no unchecked extractall.
        with zipfile.ZipFile(archive) as package:
            for item in package.infolist():
                destination = unpacked.joinpath(*item.filename.split("/"))
                destination.parent.mkdir(parents=True, exist_ok=True)
                with package.open(item) as source, destination.open("xb") as target:
                    shutil.copyfileobj(source, target, length=1024 * 1024)
        app = unpacked / TOP
        executable = app / "runtime" / "node.exe"
        absent = directory / "absent"
        env = {key: value for key, value in os.environ.items()
               if key.casefold() not in {"path", "programfiles", "programfiles(x86)", "localappdata", "skai_node_exe", "skai_codex_exe"}}
        env.update({"PATH": str(Path(os.environ["SystemRoot"]) / "System32"),
                    "ProgramFiles": str(absent), "ProgramFiles(x86)": str(absent),
                    "LOCALAPPDATA": str(absent), "SKAI_NODE_EXE": "", "SKAI_CODEX_EXE": ""})
        driver = directory / "check.cmd"
        escape = lambda value: value.replace("%", "%%")
        lines = ["@echo off", "setlocal EnableExtensions DisableDelayedExpansion",
                 *[f'set "{name}={escape(env[name])}"' for name in ["PATH", "ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA", "SKAI_NODE_EXE", "SKAI_CODEX_EXE"]],
                 f'call "{escape(str(app / "agent.cmd"))}" doctor', "exit /b %ERRORLEVEL%", ""]
        driver.write_bytes("\r\n".join(lines).encode("utf-8"))
        command = Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe"
        result = subprocess.run(f'"{command}" /d /s /c ""{driver}""', cwd=app, env=env,
                                capture_output=True, text=True, encoding="utf-8", timeout=20)
        if result.returncode:
            raise PackageError("The packaged launcher did not run successfully.")
        doctor = json.loads(result.stdout)
        if Path(doctor["tools"]["node"]).resolve() != executable.resolve() or doctor["tools"]["codex"] is not None:
            raise PackageError("Launcher did not select only the bundled runtime.")
        version = subprocess.run([str(executable), "--version"], capture_output=True, text=True, timeout=10, check=True).stdout.strip()
        if version != f"v{VERSION}":
            raise PackageError("Bundled runtime version is incorrect.")
        # Before a real task, an extracted package must create its own local
        # repository instead of relying on an outer checkout or skipping Git.
        bootstrap = "import { pathToFileURL } from 'node:url'; import path from 'node:path'; const root=process.argv[1]; const m=await import(pathToFileURL(path.join(root,'src','portable.mjs'))); await m.preparePortableWorkspace(root);"
        subprocess.run([str(executable), "--input-type=module", "-e", bootstrap, str(app)], cwd=app,
                       capture_output=True, env=os.environ.copy(), timeout=20, check=True)
        if not (app / ".git").is_dir():
            raise PackageError("Portable workspace did not create its own Git repository.")
        process = subprocess.Popen([str(executable), "src/cli.mjs", "ui", "--paused", "--port", "0"],
                                   cwd=app, env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   text=True, encoding="utf-8")
        ready = Queue()
        def read_ready():
            for line in process.stdout:
                match = re.search(r"http://127\.0\.0\.1:(\d+)", line)
                if match:
                    ready.put(int(match[1]))
                    return
        reader = Thread(target=read_ready, daemon=True)
        reader.start()
        try:
            port = ready.get(timeout=10)
        except Empty:
            raise PackageError("Packaged UI did not become ready.") from None
        def get(endpoint):
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            try:
                connection.request("GET", endpoint, headers={"X-SkAi-Client": "operator-ui"})
                response = connection.getresponse()
                data = json.loads(response.read())
                if response.status != 200:
                    raise PackageError("Packaged UI returned an unexpected response.")
                return data
            finally:
                connection.close()
        state = get("/api/state")
        memory = get("/api/memory")
        if state["executionEnabled"] or state["tasks"] or not memory["available"] or not memory["lessons"]:
            raise PackageError("Packaged UI did not preserve its safe initial state.")
        report.update({"launcher": "pass", "runtime": version, "gitWorkspace": "pass", "ui": "pass", "memory": "pass", "modelCalls": 0})
        return report
    finally:
        if process:
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=10)
            process.stdout.close()
        for attempt in range(40):
            try:
                shutil.rmtree(directory)
                break
            except FileNotFoundError:
                break
            except PermissionError:
                if attempt == 39:
                    raise
                time.sleep(0.05)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--commit", required=True)
    args = parser.parse_args()
    try:
        result = smoke(args.archive, args.commit)
        print(json.dumps(result))
        if os.environ.get("GITHUB_ACTIONS") == "true":
            print(f"::notice title=Portable package SHA256::{result['archiveSha256']}")
            print(f"::notice title=Portable content manifest SHA256::{result['fileManifestSha256']}")
            with zipfile.ZipFile(args.archive) as archive:
                lines = archive.read(TOP + "/FILES.sha256").decode("utf-8").splitlines()
            proof = json.dumps({"portableFileProof": {line.split("  ", 1)[1]: line.split("  ", 1)[0] for line in lines}}, sort_keys=True)
            print(f"::notice title=Portable file fingerprints::{proof.replace('%', '%25')}")
    except (PackageError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        message = str(error) if isinstance(error, PackageError) else "Packaged Windows execution check failed."
        if os.environ.get("GITHUB_ACTIONS") == "true":
            print(f"::error title=Portable Windows check::{message}")
        raise SystemExit(message)
