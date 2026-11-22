import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class ProtectedControlTest(unittest.TestCase):
    def run_restart(self, stuck):
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
    [ "$(cat "$TEST_ROOT/count")" -eq 0 ]
    ;;
  *) exit 1 ;;
esac
"""
            )
            fake.chmod(0o700)
            script = root / "control"
            script.write_text(
                '#!/bin/sh\nset -eu\nLABEL=ai.grogu.protected\n'
                'id() { echo 0; }\nsleep() { :; }\n'
                + control.replace("/bin/launchctl", str(fake))
            )
            result = subprocess.run(
                ["/bin/sh", str(script), "restart", "runtime"],
                env={**os.environ, "TEST_ROOT": directory, "STUCK": "1" if stuck else "0"},
                text=True,
                capture_output=True,
                check=False,
            )
            return result.returncode, result.stderr, (root / "bootstrap").exists()

    def test_waits_until_unloaded_before_bootstrap(self):
        status, stderr, bootstrapped = self.run_restart(False)
        self.assertEqual(status, 0, stderr)
        self.assertTrue(bootstrapped)

    def test_reports_timeout_without_bootstrapping(self):
        status, stderr, bootstrapped = self.run_restart(True)
        self.assertEqual(status, 75)
        self.assertIn("The service did not unload", stderr)
        self.assertFalse(bootstrapped)


if __name__ == "__main__":
    unittest.main()
