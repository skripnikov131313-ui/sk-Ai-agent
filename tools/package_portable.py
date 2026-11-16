"""Build/verify a Windows x64 package without installing anything on the host.

Uses the checked-in source snapshot and the official pinned Node archive.
Only the build command needs Git and network access; no credentials are copied.
"""
from __future__ import annotations

import argparse
import errno
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import tarfile
import time
import urllib.request
import uuid
import zipfile

ROOT = Path(__file__).resolve().parent.parent
TOP = "SkAi-Agent"
VERSION = "24.22.1"
ARCHIVE_NAME = f"node-v{VERSION}-win-x64.zip"
URL = f"https://nodejs.org/dist/v{VERSION}/{ARCHIVE_NAME}"
# From https://nodejs.org/dist/v24.22.1/SHASUMS256.txt; checked over HTTPS.
ARCHIVE_SHA = "d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5"
NODE_SHA = "d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5"
LICENSE_SHA = "ed34dd8e3f0a78dbaf00d0444ce8e285b015b765379c2e17880455f70370f8e9"
MAX_ARCHIVE = 128 * 1024 * 1024
MAX_EXPANDED = 220 * 1024 * 1024
REQUIRED = {".gitignore", "agent.cmd", "chat.cmd", "src/cli.mjs", "task-output.schema.json", "MEMORY.json"}
RESERVED = {"BUILDINFO.json", "FILES.sha256", "START-HERE.txt", "runtime/node.exe", "runtime/LICENSE.txt"}
START = """Sk/Ai Agent — Windows x64

1. Распакуйте весь архив в отдельную папку.
2. Откройте chat.cmd двойным щелчком: появится локальная панель задач.
3. Для работы исполнителя нужен установленный официальный Codex CLI с вашим входом.

Node.js уже находится в runtime; устанавливать его отдельно не требуется.
Панель можно открыть без вызова Codex. Создание задачи сохраняет её; запуск
очереди — отдельная кнопка. Закрытие вкладки не останавливает очередь;
Ctrl+C в окне запуска останавливает панель и текущую задачу.

Состояние хранится в .skai-agent внутри этой папки и не синхронизируется с
другими копиями автоматически. Чтобы обновить версию, сначала остановите
текущую панель, распакуйте новый пакет в отдельную папку и сохраните старую.
Текущий вход Codex хранится штатным клиентом; пакет не содержит credentials.

Версия исходников и runtime: BUILDINFO.json. Подробности: docs/PORTABLE_WINDOWS.md.
"""


class PackageError(Exception):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_name(name):
    if not isinstance(name, str) or not name or "\\" in name or re.search(r'[\x00-\x1f:*?"<>|]', name):
        raise PackageError("Unsafe package path.")
    parts = name.split("/")
    if PurePosixPath(name).is_absolute() or any(not part or part in (".", "..") or part != part.rstrip(" .") for part in parts):
        raise PackageError("Unsafe package path.")
    if any(re.fullmatch(r"CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]", part.split(".")[0], re.I) for part in parts):
        raise PackageError("Reserved Windows filename.")
    return name


def source_allowed(name):
    safe_name(name)
    if name == ".gitignore":
        return True
    parts = name.split("/")
    if any(part.startswith(".") or part in ("node_modules", "__pycache__") for part in parts):
        return False
    if parts[-1].casefold() in {"auth.json", "credentials.json", "tasks.json", "doctor.json", "service.json"}:
        return False
    suffix = PurePosixPath(name).suffix
    if len(parts) == 1:
        return suffix == ".md" or name in {"agent.cmd", "chat.cmd", "local.cmd", "work.cmd", "MEMORY.json", "task-output.schema.json"}
    return ((parts[0] == "docs" and suffix == ".md") or
            (parts[0] == "src" and suffix in {".mjs", ".js", ".html", ".css", ".json"}) or
            (parts[0] == "test" and suffix in {".mjs", ".py"}) or
            (parts[0] == "tools" and suffix == ".py"))


def git(root, *args):
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith("GIT_")}
    result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, timeout=60, env=env)
    if result.returncode:
        raise PackageError("Git could not read the committed source snapshot.")
    return result.stdout


def source_snapshot(root):
    if Path(git(root, "rev-parse", "--show-toplevel").decode().strip()).resolve() != root.resolve():
        raise PackageError("Source root must be its own Git checkout.")
    if git(root, "status", "--porcelain", "--untracked-files=no").strip():
        raise PackageError("Commit tracked source changes before building. Existing changes were preserved.")
    commit = git(root, "rev-parse", "HEAD").decode().strip()
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise PackageError("Expected a full Git commit.")
    timestamp = int(git(root, "show", "-s", "--format=%ct", commit))
    names = []
    total = 0
    for record in git(root, "ls-tree", "-rlz", "--full-tree", commit).split(b"\0"):
        if not record:
            continue
        metadata, name_bytes = record.split(b"\t", 1)
        name = name_bytes.decode("utf-8")
        if not source_allowed(name):
            continue
        mode, kind, _, size = metadata.split()
        if mode not in (b"100644", b"100755") or kind != b"blob":
            raise PackageError("Source package cannot contain links or submodules.")
        if int(size) > 1024 * 1024:
            raise PackageError("Source file exceeds 1 MiB.")
        total += int(size)
        names.append(name)
    if total > 10 * 1024 * 1024 or not REQUIRED.issubset(names):
        raise PackageError("Source snapshot is incomplete or too large.")
    if len(set(name.casefold() for name in names)) != len(names):
        raise PackageError("Case-insensitive source filename collision.")
    archive = git(root, "archive", "--format=tar", commit, *names)
    files = {}
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tar:
        for item in tar:
            if item.isdir():
                continue
            if item.name not in names or not item.isfile() or item.size > 1024 * 1024:
                raise PackageError("Unexpected source archive entry.")
            data = tar.extractfile(item).read()
            files[item.name] = data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n") if item.name.endswith(".cmd") else data
    if set(files) != set(names):
        raise PackageError("Incomplete source archive.")
    return files, commit, timestamp


def sha_file(file, limit=MAX_ARCHIVE):
    if file.is_symlink() or not file.is_file() or file.stat().st_size > limit:
        raise PackageError("Invalid cached runtime archive.")
    value = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def replace_file(source, target, *, windows=os.name == "nt", attempts=100, replace=os.replace, pause=time.sleep):
    for attempt in range(attempts):
        try:
            replace(source, target)
            return
        except OSError as error:
            sharing = error.errno in (errno.EACCES, errno.EPERM, errno.EBUSY) or getattr(error, "winerror", None) in (5, 32, 33)
            if not windows or not sharing or attempt + 1 == attempts:
                raise
            pause(0.02)


def download_runtime(root):
    cache = (root / ".skai-agent" / "build-cache").resolve()
    if not cache.is_relative_to(root.resolve()):
        raise PackageError("Build cache must remain inside the project.")
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / ARCHIVE_NAME
    if target.is_symlink():
        raise PackageError("Runtime cache cannot be a symlink.")
    if target.exists() and sha_file(target) == ARCHIVE_SHA:
        return target
    temporary = cache / f"{ARCHIVE_NAME}.{uuid.uuid4()}.download"
    try:
        # urllib honors the configured proxy and CA trust; TLS is never disabled.
        with urllib.request.urlopen(URL, timeout=30) as response, temporary.open("xb") as stream:
            count = 0
            while chunk := response.read(1024 * 1024):
                count += len(chunk)
                if count > MAX_ARCHIVE:
                    raise PackageError("Runtime download exceeded the size limit.")
                stream.write(chunk)
        if sha_file(temporary) != ARCHIVE_SHA:
            raise PackageError("Official runtime archive checksum mismatch.")
        replace_file(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return target


def runtime_files(archive):
    if sha_file(archive) != ARCHIVE_SHA:
        raise PackageError("Runtime archive checksum mismatch.")
    prefix = f"node-v{VERSION}-win-x64/"
    files = {}
    with zipfile.ZipFile(archive) as package:
        for member, destination, checksum, limit in [
            ("node.exe", "runtime/node.exe", NODE_SHA, 180 * 1024 * 1024),
            ("LICENSE", "runtime/LICENSE.txt", LICENSE_SHA, 5 * 1024 * 1024),
        ]:
            item = package.getinfo(prefix + member)
            if item.is_dir() or item.file_size > limit or stat.S_ISLNK(item.external_attr >> 16):
                raise PackageError("Unexpected runtime file.")
            data = package.read(item)
            if digest(data) != checksum:
                raise PackageError("Pinned runtime file checksum mismatch.")
            files[destination] = data
    return files


def write_package(files, runtime, commit, timestamp, destination):
    if not REQUIRED.issubset(files) or not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise PackageError("Incomplete source snapshot.")
    if any(not source_allowed(name) for name in files) or set(runtime) != {"runtime/node.exe", "runtime/LICENSE.txt"}:
        raise PackageError("Unexpected package inputs.")
    if digest(runtime["runtime/node.exe"]) != NODE_SHA or digest(runtime["runtime/LICENSE.txt"]) != LICENSE_SHA:
        raise PackageError("Runtime bytes do not match the pinned files.")
    contents = {**files, **runtime, "START-HERE.txt": START.encode("utf-8")}
    info = {"formatVersion": 1, "project": "Sk/Ai Agent", "platform": "win32-x64", "sourceCommit": commit,
            "sourceTimestamp": timestamp, "runtime": {"version": VERSION, "url": URL,
            "archiveSha256": ARCHIVE_SHA, "nodeSha256": NODE_SHA, "licenseSha256": LICENSE_SHA}}
    contents["BUILDINFO.json"] = (json.dumps(info, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    contents["FILES.sha256"] = "".join(f"{digest(data)}  {name}\n" for name, data in sorted(contents.items())).encode("utf-8")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_symlink():
        raise PackageError("Output archive cannot be a symlink.")
    temporary = destination.with_name(f"{destination.name}.{uuid.uuid4()}.tmp")
    # Stable timestamps and ordering avoid adding build-machine paths or times.
    stamp = time.gmtime(max(315532800, min(timestamp, 4354819198)))[:6]
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, data in sorted(contents.items()):
                item = zipfile.ZipInfo(f"{TOP}/{safe_name(name)}", date_time=stamp)
                item.create_system = 3
                item.compress_type = zipfile.ZIP_DEFLATED
                item.external_attr = (stat.S_IFREG | 0o644) << 16
                archive.writestr(item, data)
        replace_file(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    checksum = sha_file(destination)
    checksum_file = destination.with_suffix(destination.suffix + ".sha256")
    if checksum_file.is_symlink():
        raise PackageError("Checksum output cannot be a symlink.")
    checksum_file.write_text(f"{checksum}  {destination.name}\n", encoding="utf-8")
    return {"archive": str(destination), "sha256": checksum, "sourceCommit": commit, "nodeVersion": VERSION}


def verify_package(file, expected_commit=None, source_root=ROOT):
    sha_file(file)  # Validate file type and size before opening ZIP.
    with zipfile.ZipFile(file) as archive:
        entries = archive.infolist()
        if len(entries) > 500 or sum(item.file_size for item in entries) > MAX_EXPANDED:
            raise PackageError("Package exceeds the expansion limits.")
        names = []
        for item in entries:
            safe_name(item.filename)
            if not item.filename.startswith(TOP + "/") or item.is_dir() or stat.S_IFMT(item.external_attr >> 16) not in (0, stat.S_IFREG):
                raise PackageError("Unexpected package entry.")
            if item.flag_bits & 1 or item.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise PackageError("Unsupported encrypted or compressed package entry.")
            name = item.filename[len(TOP) + 1:]
            if name not in RESERVED and not source_allowed(name):
                raise PackageError("Forbidden package content.")
            limit = 180 * 1024 * 1024 if name == "runtime/node.exe" else 5 * 1024 * 1024 if name == "runtime/LICENSE.txt" else 1024 * 1024
            if item.file_size > limit:
                raise PackageError("Package entry exceeds its size limit.")
            names.append(name)
        if len(set(name.casefold() for name in names)) != len(names) or not (REQUIRED | RESERVED).issubset(names):
            raise PackageError("Duplicate or missing package entries.")
        metadata = json.loads(archive.read(TOP + "/BUILDINFO.json"))
        if metadata.get("formatVersion") != 1 or metadata.get("platform") != "win32-x64" or not re.fullmatch(r"[a-f0-9]{40}", metadata.get("sourceCommit", "")):
            raise PackageError("Invalid build metadata.")
        if expected_commit and metadata["sourceCommit"] != expected_commit:
            raise PackageError("Package source commit does not match checkout.")
        if metadata.get("runtime") != {"version": VERSION, "url": URL, "archiveSha256": ARCHIVE_SHA, "nodeSha256": NODE_SHA, "licenseSha256": LICENSE_SHA}:
            raise PackageError("Runtime metadata does not match pinned inputs.")
        manifest_bytes = archive.read(TOP + "/FILES.sha256")
        manifest = manifest_bytes.decode("utf-8").splitlines()
        checksums = {}
        for line in manifest:
            if not re.fullmatch(r"[a-f0-9]{64}  .+", line):
                raise PackageError("Invalid file manifest.")
            checksum, name = line.split("  ", 1)
            safe_name(name)
            if name in checksums:
                raise PackageError("Duplicate checksum entry.")
            checksums[name] = checksum
        if set(checksums) != set(names) - {"FILES.sha256"}:
            raise PackageError("File manifest does not cover the package.")
        for name, checksum in checksums.items():
            value = hashlib.sha256()
            with archive.open(TOP + "/" + name) as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    value.update(chunk)
            if value.hexdigest() != checksum:
                raise PackageError("Package file checksum mismatch.")
        if checksums["runtime/node.exe"] != NODE_SHA or checksums["runtime/LICENSE.txt"] != LICENSE_SHA:
            raise PackageError("Packaged runtime is not the pinned Node distribution.")
        if expected_commit:
            source_files, source_commit, timestamp = source_snapshot(source_root)
            packaged_sources = set(names) - RESERVED
            if source_commit != expected_commit or metadata.get("sourceTimestamp") != timestamp or packaged_sources != set(source_files):
                raise PackageError("Package does not contain the expected source snapshot.")
            if any(checksums[name] != digest(data) for name, data in source_files.items()):
                raise PackageError("Package source bytes differ from the committed snapshot.")
    return {"valid": True, "sourceCommit": metadata["sourceCommit"], "nodeVersion": VERSION, "files": len(names),
            "archiveSha256": sha_file(file), "fileManifestSha256": digest(manifest_bytes)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("build")
    check = commands.add_parser("verify")
    check.add_argument("archive", type=Path)
    check.add_argument("--commit")
    args = parser.parse_args()
    if args.command == "verify":
        result = verify_package(args.archive, args.commit)
    else:
        files, commit, timestamp = source_snapshot(ROOT)
        runtime = runtime_files(download_runtime(ROOT))
        destination = (ROOT / ".skai-agent" / "dist").resolve()
        if not destination.is_relative_to(ROOT.resolve()):
            raise PackageError("Output directory must remain inside the project.")
        result = write_package(files, runtime, commit, timestamp, destination / "SkAi-Agent-win-x64.zip")
        verify_package(destination / "SkAi-Agent-win-x64.zip", commit)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except PackageError as error:
        if os.environ.get("GITHUB_ACTIONS") == "true":
            print(f"::error title=Portable package::{error}")
        raise SystemExit(str(error))
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, subprocess.TimeoutExpired):
        raise SystemExit("Portable package operation failed. Existing source and task state were preserved.")
