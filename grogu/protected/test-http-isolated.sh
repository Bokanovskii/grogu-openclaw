#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
if [[ "$(uname -s)" != Darwin || ! -x /usr/bin/sandbox-exec ]]; then
  echo "This fixture requires the macOS sandbox-exec isolation launcher." >&2
  exit 1
fi

mkdir -p .artifacts
proof="$(mktemp -d "$PWD/.artifacts/protected-proof-XXXXXXXX")"
trap 'rm -rf "$proof"' EXIT
mkdir -m 700 "$proof/home" "$proof/state"

exec_command=(
  env -i
  PATH="$PATH"
  HOME="$proof/home"
  TMPDIR="$proof"
  OPENCLAW_STATE_DIR="$proof/state"
  OPENCLAW_CONFIG_PATH="$proof/state/openclaw.json"
  OPENCLAW_PROTECTED_ISOLATED_TEST=1
  node --import ./scripts/tsx.mjs --test --test-timeout=90000
  grogu/protected/http.test.ts
  grogu/protected/automations-store.test.ts
)
/usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network-outbound) (allow network-outbound (remote ip "localhost:*"))' "${exec_command[@]}"
