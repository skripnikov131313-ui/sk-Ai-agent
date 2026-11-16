"""Portable package integrity tests; fake runtime bytes, no network/model calls."""
import hashlib
import errno
import importlib.util
import io
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

REPO = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("portable_package", REPO / "tools/package_portable.py")
portable = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portable)


class PortableTests(unittest.TestCase):
    def setUp(self):
        parent = REPO / ".skai-agent" / "test-tmp"
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="portable-", dir=parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.command("init", "--quiet")
        self.files = {"agent.cmd": b"@echo off\n", "chat.cmd": b"@echo off\n", "src/cli.mjs": b"// source fixture\n",
                      "task-output.schema.json": b"{}\n", "MEMORY.json": b'{"version":1,"preferences":[],"lessons":[]}\n',
                      "README.md": b"Fixture project\n", ".gitignore": b".skai-agent/\n"}
        for name, data in self.files.items():
            file = self.source / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(data)
        self.command("add", ".")
        self.command("-c", "user.name=Portable fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Fixture source")
        self.node = b"MZ-portable-runtime-fixture"
        self.license = b"Fixture license\n"
        self.runtime_zip = self.root / "runtime.zip"
        with zipfile.ZipFile(self.runtime_zip, "w") as archive:
            archive.writestr(f"node-v{portable.VERSION}-win-x64/node.exe", self.node)
            archive.writestr(f"node-v{portable.VERSION}-win-x64/LICENSE", self.license)
        self.pins = patch.multiple(portable, ARCHIVE_SHA=portable.digest(self.runtime_zip.read_bytes()),
                                   NODE_SHA=portable.digest(self.node), LICENSE_SHA=portable.digest(self.license))
        self.pins.start()
        self.addCleanup(self.pins.stop)

    def command(self, *args):
        return subprocess.run(["git", "-C", str(self.source), *args], check=True, capture_output=True).stdout

    def build(self):
        files, commit, timestamp = portable.source_snapshot(self.source)
        archive = self.root / "output" / "SkAi-Agent-win-x64.zip"
        portable.write_package(files, portable.runtime_files(self.runtime_zip), commit, timestamp, archive)
        return archive, commit

    def rewrite(self, archive, changes, update_manifest=False):
        with zipfile.ZipFile(archive) as zipped:
            contents = {item.filename: zipped.read(item) for item in zipped.infolist()}
        contents.update({f"{portable.TOP}/{name}": data for name, data in changes.items()})
        if update_manifest:
            contents[f"{portable.TOP}/FILES.sha256"] = "".join(
                f"{portable.digest(data)}  {name[len(portable.TOP)+1:]}\n"
                for name, data in sorted(contents.items()) if not name.endswith("/FILES.sha256")).encode()
        with zipfile.ZipFile(archive, "w") as zipped:
            for name, data in contents.items():
                zipped.writestr(name, data)

    def test_clean_snapshot_and_stable_package(self):
        archive, commit = self.build()
        result = portable.verify_package(archive, commit, self.source)
        self.assertTrue(result["valid"])
        self.assertEqual(result["sourceCommit"], commit)
        before = archive.read_bytes()
        self.build()
        self.assertEqual(archive.read_bytes(), before)
        self.assertIn(hashlib.sha256(before).hexdigest(), archive.with_suffix(".zip.sha256").read_text())
        with zipfile.ZipFile(archive) as zipped:
            self.assertEqual(zipped.read(f"{portable.TOP}/agent.cmd"), b"@echo off\r\n")
            self.assertEqual(zipped.read(f"{portable.TOP}/runtime/node.exe"), self.node)
            self.assertEqual(zipped.read(f"{portable.TOP}/runtime/LICENSE.txt"), self.license)

    def test_untracked_state_and_tracked_credential_files_are_excluded(self):
        for name in [".env", "src/auth.json", ".skai-agent/tasks.json"]:
            file = self.source / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("SYNTHETIC_PRIVATE_STATE")
            self.command("add", "--force", name)
        self.command("-c", "user.name=Portable fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Private fixtures")
        (self.source / "src/untracked.mjs").write_text("SYNTHETIC_UNTRACKED")
        archive, commit = self.build()
        portable.verify_package(archive, commit, self.source)
        with zipfile.ZipFile(archive) as zipped:
            contents = b"".join(zipped.read(item) for item in zipped.infolist())
            self.assertNotIn(b"SYNTHETIC_PRIVATE", contents)
            self.assertNotIn(b"SYNTHETIC_UNTRACKED", contents)
            self.assertFalse(any(".git/" in name for name in zipped.namelist()))

    def test_dirty_source_is_preserved_and_not_mislabeled(self):
        file = self.source / "src/cli.mjs"
        file.write_text("// changed source\n")
        with self.assertRaises(portable.PackageError):
            portable.source_snapshot(self.source)
        self.assertEqual(file.read_text(), "// changed source\n")

    def test_wrong_runtime_archive_hash_is_rejected(self):
        self.runtime_zip.write_bytes(b"wrong download")
        with self.assertRaises(portable.PackageError):
            portable.runtime_files(self.runtime_zip)

    def test_verified_cache_does_not_download_again(self):
        cache = self.source / ".skai-agent/build-cache"
        cache.mkdir(parents=True)
        target = cache / portable.ARCHIVE_NAME
        shutil.copyfile(self.runtime_zip, target)
        with patch.object(portable.urllib.request, "urlopen", side_effect=AssertionError("Unexpected network call")):
            self.assertEqual(portable.download_runtime(self.source), target.resolve())

    def test_bad_download_preserves_previous_cache_and_cleans_temporary_file(self):
        cache = self.source / ".skai-agent/build-cache"
        cache.mkdir(parents=True)
        target = cache / portable.ARCHIVE_NAME
        target.write_bytes(b"old cache")
        with patch.object(portable.urllib.request, "urlopen", return_value=io.BytesIO(b"bad response")):
            with self.assertRaises(portable.PackageError):
                portable.download_runtime(self.source)
        self.assertEqual(target.read_bytes(), b"old cache")
        self.assertEqual(list(cache.glob("*.download")), [])

    def test_modified_source_is_rejected_even_when_manifest_is_rewritten(self):
        archive, commit = self.build()
        self.rewrite(archive, {"src/cli.mjs": b"// modified source"}, update_manifest=True)
        with self.assertRaises(portable.PackageError):
            portable.verify_package(archive, commit, self.source)

    def test_replaced_runtime_is_rejected_even_when_manifest_is_rewritten(self):
        archive, _ = self.build()
        self.rewrite(archive, {"runtime/node.exe": b"MZ-replaced-runtime"}, update_manifest=True)
        with self.assertRaises(portable.PackageError):
            portable.verify_package(archive)

    def test_manifest_mismatch_is_rejected(self):
        archive, _ = self.build()
        self.rewrite(archive, {"README.md": b"changed"})
        with self.assertRaises(portable.PackageError):
            portable.verify_package(archive)

    def test_private_paths_traversal_links_and_case_duplicates_are_rejected(self):
        for name in ["../../escape.txt", "runtime/../auth.json", ".skai-agent/tasks.json", "src/auth.json", "src/CLI.mjs"]:
            with self.subTest(name=name):
                archive, _ = self.build()
                self.rewrite(archive, {name: b"not allowed"}, update_manifest=True)
                with self.assertRaises(portable.PackageError):
                    portable.verify_package(archive)
        archive, _ = self.build()
        with zipfile.ZipFile(archive, "a") as zipped:
            item = zipfile.ZipInfo(f"{portable.TOP}/src/link.mjs")
            item.external_attr = (stat.S_IFLNK | 0o777) << 16
            zipped.writestr(item, "../../outside")
        with self.assertRaises(portable.PackageError):
            portable.verify_package(archive)

    def test_incorrect_source_commit_is_rejected(self):
        archive, _ = self.build()
        with self.assertRaises(portable.PackageError):
            portable.verify_package(archive, "f" * 40, self.source)

    def test_ambient_git_variables_cannot_redirect_the_source_snapshot(self):
        expected = self.command("rev-parse", "HEAD").decode().strip()
        with patch.dict(os.environ, {"GIT_DIR": str(self.root / "unrelated.git")}):
            _, commit, _ = portable.source_snapshot(self.source)
        self.assertEqual(commit, expected)

    def test_windows_replace_retries_preserve_destination_until_success_and_stop(self):
        source = self.root / "new.bin"
        target = self.root / "old.bin"
        source.write_bytes(b"new")
        target.write_bytes(b"old")
        calls = []
        def sharing_then_success(a, b):
            calls.append(1)
            self.assertEqual(target.read_bytes(), b"old")
            if len(calls) < 3:
                raise PermissionError(errno.EACCES, "fixture sharing error")
            os.replace(a, b)
        portable.replace_file(source, target, windows=True, replace=sharing_then_success, pause=lambda _: None)
        self.assertEqual(len(calls), 3)
        self.assertEqual(target.read_bytes(), b"new")
        source.write_bytes(b"another")
        def always_locked(a, b):
            raise PermissionError(errno.EACCES, "fixture sharing error")
        with self.assertRaises(PermissionError):
            portable.replace_file(source, target, windows=True, attempts=3, replace=always_locked, pause=lambda _: None)
        self.assertEqual(source.read_bytes(), b"another")
        self.assertEqual(target.read_bytes(), b"new")


if __name__ == "__main__":
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(PortableTests))
    if not result.wasSuccessful() and os.environ.get("GITHUB_ACTIONS") == "true":
        for case, details in result.failures + result.errors:
            message = (str(case) + ": " + details[-6000:]).replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
            print(f"::error title=Portable regression::{message}")
    raise SystemExit(0 if result.wasSuccessful() else 1)
