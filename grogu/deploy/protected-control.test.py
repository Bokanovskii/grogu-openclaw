import os
import hashlib
import io
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest


class ProtectedControlTest(unittest.TestCase):
    def test_update_refuses_before_replacing_service_when_release_check_fails(self):
        source = Path(__file__).with_name("protected-bootstrap-macos.sh").read_text()
        maintain = source.split('\nSCRIPT\n} > "$stage/maintain"', 1)[0].rsplit("cat <<'SCRIPT'\n", 1)[1]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("inbox", "service", "runtime/node/bin"):
                (root / name).mkdir(parents=True)
            (root / "inbox/runtime.tar").write_bytes(b"not extracted")
            (root / "service/installed").write_text("keep this release")
            node = root / "runtime/node/bin/node"
            node.write_text(
                "#!/bin/sh\n"
                'for arg do last="$arg"; done\n'
                '[ "$last" = release-check ] || exit 99\n'
                'echo "Release refused: repair child ownership, then rerun release-check." >&2\n'
                "exit 1\n"
            )
            node.chmod(0o700)
            script = root / "maintain"
            script.write_text(
                '#!/bin/sh\nset -eu\n'
                'SERVICE_USER="$(id -un)"\nSERVICE_HOME="$1"\nshift\n' + maintain
            )
            result = subprocess.run(
                ["/bin/sh", str(script), directory, "update"],
                text=True, capture_output=True, check=False,
            )
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn("Release refused:", result.stderr)
            self.assertEqual((root / "service/installed").read_text(), "keep this release")
            self.assertEqual((root / "inbox/runtime.tar").read_bytes(), b"not extracted")
            self.assertEqual(list(root.glob("service-update.*")), [])

    def run_control(self, stuck=False, refused=False, action="restart", component="runtime"):
        source = Path(__file__).with_name("protected-bootstrap-macos.sh").read_text()
        marker = '\nSCRIPT\n} > "$stage/control"'
        before_control = source.split(marker, 1)[0]
        control = before_control.rsplit("cat <<'SCRIPT'\n", 1)[1]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake = root / "launchctl"
            fake.write_text(
                """#!/bin/sh
case "$1" in
  print)
    if [ "$ACTION" = start ]; then exit 1; fi
    if [ ! -f "$TEST_ROOT/booted-out" ]; then exit 0; fi
    if [ "$STUCK" = 1 ]; then exit 0; fi
    count="$(cat "$TEST_ROOT/count")"
    if [ "$count" -gt 0 ]; then
      echo $((count - 1)) > "$TEST_ROOT/count"
      exit 0
    fi
    exit 1
    ;;
  bootout) touch "$TEST_ROOT/booted-out"; echo 2 > "$TEST_ROOT/count" ;;
  bootstrap)
    echo called > "$TEST_ROOT/bootstrap"
    if [ "$ACTION" = start ]; then exit 0; fi
    [ "$(cat "$TEST_ROOT/count")" -eq 0 ]
    ;;
  *) exit 1 ;;
esac
"""
            )
            fake.chmod(0o700)
            sudo = root / "sudo"
            sudo.write_text(
                "#!/bin/sh\n"
                '[ "$*" = "-n -u groguProtected /Library/PrivilegedHelperTools/ai.grogu.protected-maintain run release-check" ] || exit 99\n'
                'echo called > "$TEST_ROOT/preflight"\n'
                'if [ "$REFUSED" = 1 ]; then echo "Release refused: repair child ownership." >&2; exit 1; fi\n'
            )
            sudo.chmod(0o700)
            script = root / "control"
            script.write_text(
                '#!/bin/sh\nset -eu\nLABEL=ai.grogu.protected\nSERVICE_USER=groguProtected\n'
                'id() { echo 0; }\nsleep() { :; }\n'
                + control.replace("/bin/launchctl", str(fake))
                .replace("/usr/bin/sudo", str(sudo))
            )
            result = subprocess.run(
                ["/bin/sh", str(script), action, component],
                env={
                    **os.environ, "TEST_ROOT": directory, "STUCK": "1" if stuck else "0",
                    "REFUSED": "1" if refused else "0", "ACTION": action,
                },
                text=True,
                capture_output=True,
                check=False,
            )
            return result.returncode, result.stderr, (root / "bootstrap").exists(), (root / "preflight").exists()

    def test_waits_until_unloaded_before_bootstrap(self):
        status, stderr, bootstrapped, checked = self.run_control()
        self.assertEqual(status, 0, stderr)
        self.assertTrue(bootstrapped)
        self.assertTrue(checked)

    def test_reports_timeout_without_bootstrapping(self):
        status, stderr, bootstrapped, checked = self.run_control(stuck=True)
        self.assertEqual(status, 75)
        self.assertIn("The service did not unload", stderr)
        self.assertFalse(bootstrapped)
        self.assertFalse(checked)

    def test_refused_candidate_never_enters_launchd_restart_loop(self):
        for action in ("start", "restart"):
            status, stderr, bootstrapped, checked = self.run_control(refused=True, action=action)
            self.assertEqual(status, 1, stderr)
            self.assertIn("Release refused:", stderr)
            self.assertFalse(bootstrapped)
            self.assertTrue(checked)

    def test_tunnel_does_not_require_runtime_recovery(self):
        status, stderr, bootstrapped, checked = self.run_control(refused=True, component="tunnel")
        self.assertEqual(status, 0, stderr)
        self.assertTrue(bootstrapped)
        self.assertFalse(checked)


class FirstAdoptionTest(unittest.TestCase):
    def run_adoption(self, fault=""):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            helpers, home, staging, tools = [root / name for name in ("helpers", "home", "staging", "tools")]
            for folder in (helpers, home, staging, tools, home / "service", home / "inbox",
                           home / "state", home / "config", home / "secrets", home / "runtime/node/bin"):
                folder.mkdir(parents=True, exist_ok=True)
            helpers.chmod(0o755)
            home.chmod(0o700)
            staging.chmod(0o700)
            (home / "service/original").write_text("installed runtime")
            sentinels = [home / "state/retained", home / "config/retained", home / "secrets/retained",
                         helpers / "ai.grogu.protected-runtime", helpers / "ai.grogu.protected-tunnel",
                         root / "sudoers", root / "runtime.plist"]
            for file in sentinels:
                file.write_bytes(b"must remain unchanged")
            events = root / "events"
            events.write_text("")
            candidate_files = {
                "grogu/protected/main.ts": b"candidate",
                "grogu/protected/maintain.ts": b"candidate preflight",
                "scripts/tsx.mjs": b"loader",
                "pnpm-lock.yaml": b"frozen",
                "protected-client/index.html": b"client",
            }
            archive = staging / "runtime.tar"
            with tarfile.open(archive, "w") as tar:
                for name, data in candidate_files.items():
                    info = tarfile.TarInfo(name)
                    info.size = len(data)
                    tar.addfile(info, io.BytesIO(data))
            archive.chmod(0o600)
            archive_bytes = archive.read_bytes()
            old_control = b"#!/bin/sh\nexit 0\n"
            old_maintain = f"""#!/usr/bin/env python3
import pathlib, shutil, sys, tarfile
root = pathlib.Path({str(root)!r})
home = root / "home"
action = sys.argv[1]
with (root / "events").open("a") as log: log.write(action + "\\n")
if action == "receive":
    (home / "inbox/runtime.tar").write_bytes(sys.stdin.buffer.read())
elif action == "update":
    if {fault!r} == "update":
        (home / "service-update.fixture.previous").mkdir()
        sys.exit(74)
    shutil.rmtree(home / "service")
    (home / "service").mkdir()
    with tarfile.open(home / "inbox/runtime.tar") as tar: tar.extractall(home / "service")
    (home / "inbox/runtime.tar").unlink()
elif action != "dependencies":
    sys.exit(99)
""".encode()
            old_bytes = {"control": old_control, "maintain": old_maintain}
            for target, data in old_bytes.items():
                file = helpers / ("ai.grogu.protected-" + target)
                file.write_bytes(data)
                file.chmod(0o755)
            tool_body = f"""#!/usr/bin/env python3
import os, pathlib, shutil, stat, subprocess, sys
root = pathlib.Path({str(root)!r})
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
fault = {fault!r}
if name == "id":
    if args == ["-u"]: print(0)
    elif args == ["-u", "groguProtected"]: print(502)
    elif args == ["-u", "operator"]: print(501)
elif name == "uname":
    print("Darwin" if args == ["-s"] else "arm64")
elif name == "stat":
    file = pathlib.Path(args[-1])
    info = file.stat()
    uid = 502 if file == root / "home" else 501 if file == root / "staging" or file.parent == root / "staging" else 0
    fields = {{"%u": str(uid), "%g": "0", "%Lp": format(stat.S_IMODE(info.st_mode), "o"), "%l": str(info.st_nlink)}}
    print(":".join(fields[field] for field in args[1].split(":")))
elif name == "launchctl":
    assert args[0] == "print", "adoption must not change service activation"
    sys.exit(0 if args[1] == "system" or fault == "loaded" else 113)
elif name == "sudo":
    assert args[:2] == ["-u", "groguProtected"]
    sys.exit(subprocess.call(args[2:]))
elif name == "install":
    args = [args[i] for i in range(len(args)) if i not in (0, 1, 2, 3)]
    sys.exit(subprocess.call(["/usr/bin/install"] + args))
elif name == "mv":
    if fault == "publish" and pathlib.Path(args[-2]).name == "maintain" and args[-1].endswith("-maintain"):
        sys.exit(74)
    sys.exit(subprocess.call(["/bin/mv"] + args))
elif name == "node":
    if "install" in args:
        with (root / "events").open("a") as log: log.write("candidate-dependencies\\n")
    else:
        assert args[-1] == "release-check"
        assert os.environ["HOME"] == str(root / "home")
        for key, suffix in (("OPENCLAW_STATE_DIR", "state"), ("OPENCLAW_CONFIG_PATH", "config/openclaw.json"),
                            ("OPENCLAW_PROTECTED_STORAGE_KEY_FILE", "secrets/storage-key")):
            assert os.environ[key] == str(root / "home" / suffix), key
        installed = pathlib.Path.cwd() == (root / "home/service").resolve()
        assert (pathlib.Path.cwd() / "grogu/protected/maintain.ts").read_bytes() == b"candidate preflight"
        with (root / "events").open("a") as log: log.write("installed-check\\n" if installed else "candidate-check\\n")
        if fault == "candidate": sys.exit(78)
        if fault == "replace-input" and not installed:
            (root / "staging/runtime.tar").write_bytes(b"changed after admission")
"""
            for name in ("id", "uname", "stat", "launchctl", "sudo", "install", "mv"):
                file = tools / name
                file.write_text(tool_body)
                file.chmod(0o755)
            node = home / "runtime/node/bin/node"
            node.write_text(tool_body)
            node.chmod(0o755)
            source = Path(__file__).with_name("protected-bootstrap-macos.sh").read_text()
            source = source.replace("export PATH=/usr/bin:/bin:/usr/sbin:/sbin",
                                    f"export PATH={tools}:/usr/bin:/bin:/usr/sbin:/sbin")
            source = source.replace('service_home="/Users/$service_user"', f'service_home="{home}"')
            source = source.replace("/Library/PrivilegedHelperTools", str(helpers))
            source = source.replace('"/var/run/$label.bootstrap"', f'"{root}/bootstrap.lock"')
            for executable in ("/usr/bin/sudo", "/bin/launchctl", "/usr/bin/install", "/bin/mv"):
                source = source.replace(executable, str(tools / Path(executable).name))
            source = source.replace("old_control=77ad55d13d05eaea08fb454ae34a19f22425c54e25789ed32d5c3ca566c2a290",
                                    "old_control=" + hashlib.sha256(old_control).hexdigest())
            source = source.replace("old_maintain=0b20d9bd2dce52b9714b6a198508ff778efbab300eb563dd5ad413c2c15e5926",
                                    "old_maintain=" + hashlib.sha256(old_maintain).hexdigest())
            context = f"#!/bin/sh\nset -eu\numask 077\nSERVICE_USER='groguProtected'\nSERVICE_HOME='{home}'\nLABEL='ai.grogu.protected'\n"
            new_bytes = {}
            for target, pin in (("control", "d548f30ff825394a3beb467c5dbb22b9efbca9e0a4d542bfe71318fbaf069f9b"),
                                ("maintain", "e7fb8b2488a24103b534852cca40ae36e9cec70349cc48e6f734bc8bc1491410")):
                body = source.split('\nSCRIPT\n} > "$stage/' + target + '"', 1)[0].rsplit("cat <<'SCRIPT'\n", 1)[1] + "\n"
                new_bytes[target] = (context + body).encode()
                digest = hashlib.sha256(new_bytes[target]).hexdigest()
                source = source.replace("new_" + target + "=" + pin, "new_" + target + "=" + digest)
            if fault == "old-helper":
                (helpers / "ai.grogu.protected-control").write_bytes(b"unrecognized helper")
                old_bytes["control"] = b"unrecognized helper"
            if fault == "unsafe-mode":
                (helpers / "ai.grogu.protected-control").chmod(0o777)
            if fault == "new-helper":
                source = source.replace(hashlib.sha256(new_bytes["control"]).hexdigest(), "0" * 64)
            script = root / "bootstrap.sh"
            script.write_text(source)
            digest = "0" * 64 if fault == "archive" else hashlib.sha256(archive_bytes).hexdigest()
            result = subprocess.run(
                ["/bin/bash", str(script), "--operator", "operator", "--staging-dir", str(staging),
                 "--adopt-release-check", "--archive-sha256", digest],
                text=True, capture_output=True, check=False,
            )
            after = {target: (helpers / ("ai.grogu.protected-" + target)).read_bytes() for target in old_bytes}
            for file in sentinels:
                self.assertEqual(file.read_bytes(), b"must remain unchanged", str(file))
            custody = list(helpers.glob(".grogu-adoption.*"))
            candidates = list(home.glob("adoption-candidate.*"))
            if fault == "update":
                self.assertEqual(len(custody), 1)
                self.assertEqual(len(candidates), 1)
                self.assertTrue((root / "bootstrap.lock").exists())
                self.assertEqual((custody[0] / "runtime.tar").read_bytes(), archive_bytes)
                self.assertTrue((home / "service-update.fixture.previous").exists())
            else:
                self.assertEqual(custody, [], result.stderr)
                self.assertEqual(candidates, [], result.stderr)
                self.assertFalse((root / "bootstrap.lock").exists(), result.stderr)
            return result, events.read_text().splitlines(), after, old_bytes, new_bytes, (home / "service/original").exists()

    def test_refusals_leave_installation_unchanged(self):
        for fault in ("old-helper", "unsafe-mode", "archive", "new-helper", "loaded", "candidate"):
            with self.subTest(fault=fault):
                result, events, after, old, _, original = self.run_adoption(fault)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(after, old)
                self.assertTrue(original)
                self.assertNotIn("update", events)

    def test_checked_artifact_installs_and_only_two_helpers_change(self):
        result, events, after, _, new, original = self.run_adoption("replace-input")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(after, new)
        self.assertFalse(original)
        self.assertEqual(events, ["candidate-dependencies", "candidate-check", "receive", "update",
                                  "dependencies", "installed-check"])

    def test_partial_helper_publication_restores_previous_pair(self):
        result, events, after, old, _, original = self.run_adoption("publish")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("installed-check", events)
        self.assertEqual(after, old)
        self.assertFalse(original)
        self.assertIn("previous helper pair retained", result.stderr)

    def test_uncertain_update_keeps_recovery_custody(self):
        result, events, after, old, _, _ = self.run_adoption("update")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(after, old)
        self.assertIn("update", events)
        self.assertNotIn("installed-check", events)
        self.assertIn("Adoption did not settle", result.stderr)


if __name__ == "__main__":
    unittest.main()
