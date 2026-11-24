import os
from pathlib import Path
import subprocess
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


if __name__ == "__main__":
    unittest.main()
