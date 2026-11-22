#!/bin/bash
set -euo pipefail
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

usage() {
  echo "Usage: sudo /bin/bash $0 --operator USER [--staging-dir DIR] [--service-user groguProtected]"
  echo "       /bin/bash $0 --operator USER --verify"
  echo "       /bin/bash $0 --operator USER --add-subject UUID"
  echo "       sudo /bin/bash $0 --operator USER [--staging-dir DIR] --install-policy-helper"
  echo "       sudo /bin/bash $0 --operator USER [--staging-dir DIR] --update-policy-helper"
  echo "Creates isolated service ownership. It does not activate either service."
}

operator=""
service_user="groguProtected"
staging_dir=""
mode="install"
subject=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --operator|--service-user|--staging-dir|--add-subject)
      [ "$#" -ge 2 ] || { usage >&2; exit 64; }
      case "$1" in
        --operator) operator="$2" ;;
        --service-user) service_user="$2" ;;
        --staging-dir) staging_dir="$2" ;;
        --add-subject) mode="add-subject"; subject="$2" ;;
      esac
      shift 2
      ;;
    --help) usage; exit 0 ;;
    --verify) mode="verify"; shift ;;
    --install-policy-helper) mode="install-policy-helper"; shift ;;
    --update-policy-helper) mode="update-policy-helper"; shift ;;
    *) usage >&2; exit 64 ;;
  esac
done

[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || {
  echo "This bootstrap requires an arm64 Mac." >&2; exit 69;
}
[[ "$operator" =~ ^[A-Za-z][A-Za-z0-9_]{0,30}$ ]] || { usage >&2; exit 64; }
[[ "$service_user" =~ ^[A-Za-z][A-Za-z0-9_]{0,30}$ ]] || { usage >&2; exit 64; }
[ "$operator" != "$service_user" ] || { echo "The operator and service must differ." >&2; exit 64; }
id "$operator" >/dev/null
service_home="/Users/$service_user"
label="ai.grogu.protected"
helpers="/Library/PrivilegedHelperTools"
sudoers="/private/etc/sudoers.d/ai-grogu-protected"
if [ "$mode" = verify ]; then
  failed=0
  for target in runtime tunnel; do
    echo "$target daemon:"
    if ! /usr/bin/sudo -n "$helpers/$label-control" status "$target"; then failed=1; fi
  done
  if ! /usr/bin/sudo -n -u "$service_user" "$helpers/$label-maintain" verify; then failed=1; fi
  exit "$failed"
fi
if [ "$mode" = add-subject ]; then
  [[ "$subject" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || {
    echo "Supply the verified Access subject UUID, not an email address." >&2; exit 64;
  }
  was_running=0
  if /usr/bin/sudo -n "$helpers/$label-control" status runtime >/dev/null 2>&1; then
    was_running=1
    /usr/bin/sudo -n "$helpers/$label-control" stop runtime
  fi
  if ! /usr/bin/sudo -n -u "$service_user" "$helpers/$label-maintain" run add-subject "$subject"; then
    if [ "$was_running" -eq 1 ]; then
      /usr/bin/sudo -n "$helpers/$label-control" start runtime || {
        echo "Maintenance failed and the listener could not be restarted." >&2; exit 1;
      }
    fi
    exit 1
  fi
  exec /usr/bin/sudo -n "$helpers/$label-control" restart runtime
fi
[ "$(id -u)" -eq 0 ] || { echo "Run the install step through sudo." >&2; exit 77; }
operator_uid="$(id -u "$operator")"
staging_dir="${staging_dir:-/Users/$operator/.config/grogu-protected/staging}"
[ -d "$staging_dir" ] && [ ! -L "$staging_dir" ] &&
  [ "$(stat -f '%u' "$staging_dir")" = "$operator_uid" ] &&
  [ "$(stat -f '%Lp' "$staging_dir")" = 700 ] || {
    echo "The staging directory must be operator-owned, private, and not a link." >&2; exit 77;
  }
if [ "$mode" = install-policy-helper ] || [ "$mode" = update-policy-helper ]; then
  id "$service_user" >/dev/null
  helper_input="$staging_dir/protected-policy-helper.py"
  policy_input="$staging_dir/protected-policy-config.json"
  inputs=("$helper_input")
  if [ "$mode" = install-policy-helper ]; then inputs+=("$policy_input"); fi
  for input in "${inputs[@]}"; do
    [ -f "$input" ] && [ ! -L "$input" ] && [ -s "$input" ] &&
      [ "$(stat -f '%u' "$input")" = "$operator_uid" ] &&
      [ "$(stat -f '%Lp' "$input")" = 600 ] &&
      [ "$(stat -f '%l' "$input")" = 1 ] || {
        echo "Policy staging inputs must be operator-owned regular files, mode 0600, without links." >&2
        exit 77
      }
  done
  echo "8b1876aaa8bd11e5a18592bc6369b95f1d55184c29bcb9960a8acbe692a3d4d8  $helper_input" |
    /usr/bin/shasum -a 256 -c - >/dev/null || {
      echo "Policy helper source does not match the reviewed installer." >&2; exit 65;
    }
  policy_dir="/private/var/db/ai.grogu.protected"
  policy_sudoers="/private/etc/sudoers.d/ai-grogu-protected-policy"
  for directory in "$helpers" /private/etc/sudoers.d /private/var/db; do
    [ -d "$directory" ] && [ ! -L "$directory" ] &&
      [ "$(stat -f '%u' "$directory")" = 0 ] &&
      [ "$(stat -f '%Lp' "$directory")" = 755 ] || {
        echo "The policy helper requires root-owned system directories." >&2; exit 77;
      }
  done
  if [ "$mode" = update-policy-helper ]; then
    installed="$helpers/$label-policy.py"
    [ -f "$installed" ] && [ ! -L "$installed" ] &&
      [ "$(stat -f '%u' "$installed")" = 0 ] &&
      [ "$(stat -f '%Lp' "$installed")" = 644 ] &&
      [ "$(stat -f '%l' "$installed")" = 1 ] || {
        echo "The installed policy helper is not the expected root-owned file." >&2; exit 77;
      }
    echo "76a94aa66caea08759a535a2e9c4e594dc4574c30d703e49016108fd5ab04b4b  $installed" |
      /usr/bin/shasum -a 256 -c - >/dev/null || {
        echo "The installed policy helper does not match the previous release." >&2; exit 65;
      }
    staged_helper="$(mktemp "$helpers/.grogu-policy-update.XXXXXX")"
    trap '/bin/rm -f "$staged_helper"' EXIT
    /usr/bin/install -o root -g wheel -m 644 "$helper_input" "$staged_helper"
    echo "8b1876aaa8bd11e5a18592bc6369b95f1d55184c29bcb9960a8acbe692a3d4d8  $staged_helper" |
      /usr/bin/shasum -a 256 -c - >/dev/null || {
        echo "Policy helper source changed during staging." >&2; exit 65;
      }
    /bin/mv -f "$staged_helper" "$installed"
    echo "Updated the root-owned policy helper. No Cloudflare request was made."
    exit 0
  fi
  /usr/bin/plutil -convert xml1 -o /dev/null "$policy_input"
  for field in accountId appId policyId policyName ownerEmail token; do
    /usr/bin/plutil -extract "$field" raw -expect string -o - "$policy_input" |
      /usr/bin/grep -q . || { echo "Policy configuration is incomplete." >&2; exit 65; }
  done
  for output in "$helpers/$label-policy" "$helpers/$label-policy.py" "$policy_sudoers" "$policy_dir"; do
    [ ! -e "$output" ] && [ ! -L "$output" ] || {
      echo "An existing policy helper requires inspection before installation." >&2; exit 73;
    }
  done
  stage="$(mktemp -d /private/tmp/grogu-protected-policy.XXXXXX)"
  trap '/bin/rm -f "$stage/wrapper" "$stage/sudoers"; /bin/rmdir "$stage"' EXIT
  cat > "$stage/wrapper" <<'SCRIPT'
#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] && [ "$#" -eq 0 ] || exit 64
exec /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  /usr/bin/python3 -I -S /Library/PrivilegedHelperTools/ai.grogu.protected-policy.py
SCRIPT
  printf '%s\n' \
    "$service_user ALL=(root) NOPASSWD: $helpers/$label-policy \"\"" > "$stage/sudoers"
  /bin/sh -n "$stage/wrapper"
  /usr/sbin/visudo -cf "$stage/sudoers" >/dev/null
  /bin/mkdir -m 700 "$policy_dir"
  /usr/bin/install -o root -g wheel -m 600 "$policy_input" "$policy_dir/policy.json"
  /usr/bin/install -o root -g wheel -m 644 "$helper_input" "$helpers/$label-policy.py"
  /usr/bin/install -o root -g wheel -m 755 "$stage/wrapper" "$helpers/$label-policy"
  /usr/bin/install -o root -g wheel -m 440 "$stage/sudoers" "$policy_sudoers"
  /usr/bin/cmp -s "$policy_input" "$policy_dir/policy.json"
  /usr/bin/sudo -u "$operator" /bin/rm "$policy_input"
  echo "Installed the root-owned fixed policy helper. No Cloudflare request was made."
  exit 0
fi
tunnel_input="$staging_dir/cloudflared-tunnel-token"
sparky_input="$staging_dir/sparky-api-key"
deploy_input="$staging_dir/cloudflare-deploy.json"
for input in "$tunnel_input" "$sparky_input" "$deploy_input"; do
  [ -f "$input" ] && [ ! -L "$input" ] && [ -s "$input" ] &&
    [ "$(stat -f '%u' "$input")" = "$operator_uid" ] &&
    [ "$(stat -f '%Lp' "$input")" = 600 ] &&
    [ "$(stat -f '%l' "$input")" = 1 ] || {
      echo "Staging inputs must be nonempty operator-owned regular files, mode 0600, without links." >&2
      exit 77
    }
done
/usr/bin/plutil -convert xml1 -o /dev/null "$deploy_input"
for field in origin accessIssuer accessAudience tunnelId accountId accessAppId; do
  value="$(/usr/bin/plutil -extract "$field" raw -expect string -o - "$deploy_input")"
  [ -n "$value" ] && [[ "$value" != *'<'* ]] && [[ "$value" != *'>'* ]] || {
    echo "Replace the deployment placeholders before installation." >&2; exit 65;
  }
done
[ "$(/usr/bin/plutil -extract port raw -expect integer -o - "$deploy_input")" = 19789 ] || {
  echo "The isolated protected port must be 19789." >&2; exit 65;
}
for directory in "$helpers" /Library/LaunchDaemons /private/etc/sudoers.d; do
  if [ ! -e "$directory" ] && [ ! -L "$directory" ]; then
    mkdir "$directory"
    chown root:wheel "$directory"
    chmod 755 "$directory"
  fi
  [ -d "$directory" ] && [ ! -L "$directory" ] &&
    [ "$(stat -f '%u' "$directory")" = 0 ] &&
    [ "$(stat -f '%Lp' "$directory")" = 755 ] || {
      echo "The system helper directories require root ownership and mode 0755." >&2; exit 77;
    }
done
lock="/var/run/$label.bootstrap"
mkdir "$lock" || { echo "Another bootstrap owns $lock. Do not remove an active lock." >&2; exit 75; }
stage="$(mktemp -d /private/tmp/grogu-protected-bootstrap.XXXXXX)"
cleanup() {
  rm -f "$stage/cloudflared.tgz" "$stage/cloudflared" "$stage/runtime" "$stage/tunnel" \
    "$stage/control" "$stage/maintain" "$stage/sudoers" "$stage/runtime.plist" "$stage/tunnel.plist"
  rmdir "$stage"
  rmdir "$lock"
}
trap cleanup EXIT

# These are the only root-owned output paths. Existing installations are not
# overwritten by a bootstrap that cannot prove their ownership.
for output in "$helpers/$label-runtime" "$helpers/$label-tunnel" "$helpers/$label-control" \
  "$helpers/$label-maintain" "$sudoers" \
  "/Library/LaunchDaemons/$label.runtime.plist" "/Library/LaunchDaemons/$label.tunnel.plist"; do
  [ ! -e "$output" ] && [ ! -L "$output" ] || {
    echo "Existing protected installation found at $output. Use its maintenance owner." >&2; exit 73;
  }
done
if id "$service_user" >/dev/null 2>&1 ||
  dscl . -read "/Groups/$service_user" >/dev/null 2>&1 ||
  [ -e "$service_home" ] || [ -L "$service_home" ]; then
  echo "The selected service account, group, or home already exists. Inspect it before provisioning." >&2
  exit 73
fi

curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
  "https://github.com/cloudflare/cloudflared/releases/download/2026.11.1/cloudflared-darwin-arm64.tgz" \
  --output "$stage/cloudflared.tgz"
echo "02fe4bcf08f2c09699cff30658228a739a0c47fb75f3653d1b8772a27ade4462  $stage/cloudflared.tgz" | shasum -a 256 -c -
tar -xOf "$stage/cloudflared.tgz" cloudflared > "$stage/cloudflared"

uid=550
while dscl . -search /Users UniqueID "$uid" | grep -q .; do uid=$((uid + 1)); done
gid=550
while dscl . -search /Groups PrimaryGroupID "$gid" | grep -q .; do gid=$((gid + 1)); done
dscl . -create "/Groups/$service_user"
dscl . -create "/Groups/$service_user" PrimaryGroupID "$gid"
dscl . -create "/Groups/$service_user" RealName "Grogu Protected service"
dscl . -create "/Groups/$service_user" Password '*'
dscl . -create "/Users/$service_user"
dscl . -create "/Users/$service_user" UniqueID "$uid"
dscl . -create "/Users/$service_user" PrimaryGroupID "$gid"
dscl . -create "/Users/$service_user" RealName "Grogu Protected service"
dscl . -create "/Users/$service_user" UserShell /usr/bin/false
dscl . -create "/Users/$service_user" NFSHomeDirectory "$service_home"
dscl . -create "/Users/$service_user" Password '*'
dscl . -create "/Users/$service_user" IsHidden 1
mkdir "$service_home"
chown "$service_user:$service_user" "$service_home"
chmod 700 "$service_home"

as_service() {
  /usr/bin/sudo -u "$service_user" /usr/bin/env -i \
    HOME="$service_home" PATH="$service_home/runtime/node/bin:$service_home/runtime/pnpm/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$@"
}
as_service /bin/mkdir -p "$service_home/runtime/bin" "$service_home/service" \
  "$service_home/config" "$service_home/secrets" "$service_home/state/logs" "$service_home/inbox"
as_service /bin/chmod 700 "$service_home/secrets" "$service_home/inbox"
as_service /usr/bin/openssl rand -out "$service_home/secrets/storage-key" 32
as_service /bin/chmod 600 "$service_home/secrets/storage-key"
cat "$stage/cloudflared" | as_service /usr/bin/tee "$service_home/runtime/bin/cloudflared" >/dev/null
as_service /bin/chmod 700 "$service_home/runtime/bin/cloudflared"
cat "$tunnel_input" | as_service /usr/bin/tee "$service_home/secrets/tunnel-token" >/dev/null
cat "$sparky_input" | as_service /usr/bin/tee "$service_home/secrets/sparky-key" >/dev/null
cat "$deploy_input" | as_service /usr/bin/tee "$service_home/config/cloudflare-deploy.json" >/dev/null
as_service /bin/chmod 600 "$service_home/secrets/tunnel-token" "$service_home/secrets/sparky-key"

context() {
  printf '%s\n' '#!/bin/sh' 'set -eu' 'umask 077' \
    "SERVICE_USER='$service_user'" "SERVICE_HOME='$service_home'" "LABEL='$label'"
}
{
  context
  cat <<'SCRIPT'
[ "$(id -un)" = "$SERVICE_USER" ] || exit 77
exec >> "$SERVICE_HOME/state/logs/runtime.stdout.log" 2>> "$SERVICE_HOME/state/logs/runtime.stderr.log"
export HOME="$SERVICE_HOME" OPENCLAW_STATE_DIR="$SERVICE_HOME/state"
export OPENCLAW_CONFIG_PATH="$SERVICE_HOME/config/openclaw.json"
export OPENCLAW_PROTECTED_STORAGE_KEY_FILE="$SERVICE_HOME/secrets/storage-key"
export PATH="$SERVICE_HOME/runtime/node/bin:$SERVICE_HOME/runtime/pnpm/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SPARKY_API_KEY="$(cat "$SERVICE_HOME/secrets/sparky-key")"
[ -n "$SPARKY_API_KEY" ] || { echo "The isolated Sparky credential is empty." >&2; exit 78; }
export SPARKY_API_KEY
exec "$SERVICE_HOME/runtime/node/bin/node" --import "$SERVICE_HOME/service/scripts/tsx.mjs" \
  "$SERVICE_HOME/service/grogu/protected/main.ts" "$SERVICE_HOME/config/protected.json"
SCRIPT
} > "$stage/runtime"
{
  context
  cat <<'SCRIPT'
[ "$(id -un)" = "$SERVICE_USER" ] || exit 77
exec >> "$SERVICE_HOME/state/logs/tunnel.stdout.log" 2>> "$SERVICE_HOME/state/logs/tunnel.stderr.log"
exec "$SERVICE_HOME/runtime/bin/cloudflared" --no-autoupdate \
  --config /dev/null tunnel --metrics 127.0.0.1:19790 run \
  --token-file "$SERVICE_HOME/secrets/tunnel-token"
SCRIPT
} > "$stage/tunnel"
{
  context
  cat <<'SCRIPT'
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
[ "$(id -u)" -eq 0 ] && [ "$#" -eq 2 ] || exit 64
case "$2" in runtime|tunnel) target="$LABEL.$2" ;; *) exit 64 ;; esac
plist="/Library/LaunchDaemons/$target.plist"
case "$1" in
  start)
    if /bin/launchctl print "system/$target" >/dev/null 2>&1; then
      echo "The service is already loaded. Use restart for a new build." >&2; exit 73
    fi
    /bin/launchctl bootstrap system "$plist"
    ;;
  restart)
    if /bin/launchctl print "system/$target" >/dev/null 2>&1; then
      /bin/launchctl bootout "system/$target"
      attempts=0
      while /bin/launchctl print "system/$target" >/dev/null 2>&1; do
        attempts=$((attempts + 1))
        if [ "$attempts" -ge 30 ]; then
          echo "The service did not unload after 30 seconds; restart stopped." >&2
          exit 75
        fi
        sleep 1
      done
    fi
    /bin/launchctl bootstrap system "$plist"
    ;;
  stop) /bin/launchctl bootout "system/$target" ;;
  status)
    state="$(/bin/launchctl print "system/$target")"
    printf '%s\n' "$state" | /usr/bin/awk '/state =|pid =|last exit code =/ {print}'
    ;;
  *) exit 64 ;;
esac
SCRIPT
} > "$stage/control"
{
  context
  cat <<'SCRIPT'
[ "$(id -un)" = "$SERVICE_USER" ] || exit 77
export HOME="$SERVICE_HOME" OPENCLAW_STATE_DIR="$SERVICE_HOME/state"
export OPENCLAW_CONFIG_PATH="$SERVICE_HOME/config/openclaw.json"
export OPENCLAW_PROTECTED_STORAGE_KEY_FILE="$SERVICE_HOME/secrets/storage-key"
export PATH="$SERVICE_HOME/runtime/node/bin:$SERVICE_HOME/runtime/pnpm/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$SERVICE_HOME"
case "${1-}" in
  provision-node)
    [ "$#" -eq 1 ] || exit 64
    [ ! -L "$SERVICE_HOME/runtime/node" ] && [ ! -L "$SERVICE_HOME/runtime/pnpm" ] || exit 77
    if [ -e "$SERVICE_HOME/runtime/pnpm" ]; then
      echo "An existing pnpm runtime requires inspection before provisioning." >&2
      exit 73
    fi
    download="$(mktemp -d "$SERVICE_HOME/inbox/node.XXXXXX")"
    artifact=node-v26.12.1-darwin-arm64.tar.gz
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      "https://nodejs.org/dist/v26.12.1/$artifact" -o "$download/$artifact"
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      https://nodejs.org/dist/v26.12.1/SHASUMS256.txt -o "$download/SHASUMS256.txt"
    checksum="$(awk -v name="$artifact" '$2 == name {print $1}' "$download/SHASUMS256.txt")"
    [ "${#checksum}" -eq 64 ] || exit 65
    printf '%s  %s\n' "$checksum" "$download/$artifact" | shasum -a 256 -c --status
    /usr/bin/tar -xzf "$download/$artifact" -C "$download"
    candidate="$download/node-v26.12.1-darwin-arm64"
    if [ -e "$SERVICE_HOME/runtime/node" ]; then
      [ -d "$SERVICE_HOME/runtime/node" ] || exit 77
      /usr/bin/diff -qr "$candidate" "$SERVICE_HOME/runtime/node" >/dev/null || {
        echo "The existing Node distribution differs from the verified release." >&2
        exit 77
      }
      /bin/rm -rf "$candidate"
    else
      /bin/mv "$candidate" "$SERVICE_HOME/runtime/node"
    fi
    "$SERVICE_HOME/runtime/node/bin/node" \
      "$SERVICE_HOME/runtime/node/lib/node_modules/npm/bin/npm-cli.js" \
      install --global --ignore-scripts --prefix "$SERVICE_HOME/runtime/pnpm" pnpm@12.15.0
    rm "$download/$artifact" "$download/SHASUMS256.txt"
    rmdir "$download"
    ;;
  receive)
    [ "$#" -eq 1 ] || exit 64
    cat > "$SERVICE_HOME/inbox/runtime.tar"
    ;;
  install)
    [ "$#" -eq 1 ] || exit 64
    [ -z "$(ls -A "$SERVICE_HOME/service")" ] || {
      echo "Initial installation requires an empty service directory. Use the runtime update owner." >&2
      exit 73
    }
    /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin \
      /usr/bin/tar -xf "$SERVICE_HOME/inbox/runtime.tar" -C "$SERVICE_HOME/service"
    rm "$SERVICE_HOME/inbox/runtime.tar"
    ;;
  update)
    [ "$#" -eq 1 ] || exit 64
    archive="$SERVICE_HOME/inbox/runtime.tar"
    [ -f "$archive" ] && [ ! -L "$archive" ] || exit 66
    [ -d "$SERVICE_HOME/service" ] && [ ! -L "$SERVICE_HOME/service" ] || exit 77
    if ls -d "$SERVICE_HOME"/service-update.* >/dev/null 2>&1; then
      echo "An earlier update left staging state that requires inspection." >&2
      exit 73
    fi
    staged="$(mktemp -d "$SERVICE_HOME/service-update.XXXXXX")"
    trap '/bin/rm -rf "$staged"' EXIT
    /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin \
      /usr/bin/tar -xf "$archive" -C "$staged/"
    for required in grogu/protected/main.ts scripts/tsx.mjs pnpm-lock.yaml protected-client/index.html; do
      [ -f "$staged/$required" ] && [ ! -L "$staged/$required" ] || exit 65
    done
    /bin/chmod "$(/usr/bin/stat -f %Lp "$SERVICE_HOME/service")" "$staged"
    previous="$staged.previous"
    /bin/mv "$SERVICE_HOME/service" "$previous"
    /bin/mv "$staged" "$SERVICE_HOME/service" || { /bin/mv "$previous" "$SERVICE_HOME/service"; exit 74; }
    trap - EXIT
    /bin/rm -rf "$previous"
    rm "$archive"
    ;;
  dependencies)
    [ "$#" -eq 1 ] || exit 64
    cd "$SERVICE_HOME/service"
    exec /usr/bin/env -i HOME="$HOME" PATH="$PATH" \
      "$SERVICE_HOME/runtime/node/bin/node" "$SERVICE_HOME/runtime/pnpm/lib/node_modules/pnpm/bin/pnpm.mjs" \
      install --frozen-lockfile --ignore-scripts
    ;;
  verify)
    [ "$#" -eq 1 ] || exit 64
    failed=0
    id
    if ! stat -f '%N owner=%Su mode=%Lp' "$SERVICE_HOME" \
      "$SERVICE_HOME/secrets/tunnel-token" "$SERVICE_HOME/secrets/sparky-key" \
      "$SERVICE_HOME/secrets/storage-key" \
      /Library/PrivilegedHelperTools/ai.grogu.protected-runtime \
      /Library/PrivilegedHelperTools/ai.grogu.protected-tunnel \
      /Library/PrivilegedHelperTools/ai.grogu.protected-control \
      /Library/PrivilegedHelperTools/ai.grogu.protected-maintain \
      /Library/LaunchDaemons/ai.grogu.protected.runtime.plist \
      /Library/LaunchDaemons/ai.grogu.protected.tunnel.plist; then failed=1; fi
  if [ ! -f "$SERVICE_HOME/secrets/storage-key" ] ||
    [ -L "$SERVICE_HOME/secrets/storage-key" ] ||
    [ "$(stat -f '%Lp' "$SERVICE_HOME/secrets/storage-key")" != 600 ] ||
    [ "$(stat -f '%z' "$SERVICE_HOME/secrets/storage-key")" != 32 ] ||
    [ "$(stat -f '%u' "$SERVICE_HOME/secrets/storage-key")" != "$(id -u)" ]; then
    echo "The protected storage key is missing or has unsafe ownership or permissions." >&2
    failed=1
  fi
    for endpoint in "protected http://127.0.0.1:19789/healthz" \
      "tunnel http://127.0.0.1:19790/ready" "personal http://127.0.0.1:18789/"; do
      name="${endpoint%% *}"
      url="${endpoint#* }"
      code="$(curl --silent --show-error --max-time 5 --output /dev/null --write-out '%{http_code}' "$url")" || {
        echo "$name health unavailable" >&2; failed=1; continue;
      }
      echo "$name HTTP $code"
      if [ "$code" != 200 ]; then failed=1; fi
    done
    exit "$failed"
    ;;
  run)
    shift
    cd "$SERVICE_HOME/service"
    exec /usr/bin/env -i HOME="$HOME" PATH="$PATH" \
      OPENCLAW_STATE_DIR="$OPENCLAW_STATE_DIR" OPENCLAW_CONFIG_PATH="$OPENCLAW_CONFIG_PATH" \
      OPENCLAW_PROTECTED_STORAGE_KEY_FILE="$OPENCLAW_PROTECTED_STORAGE_KEY_FILE" \
      "$SERVICE_HOME/runtime/node/bin/node" --import "$SERVICE_HOME/service/scripts/tsx.mjs" \
      "$SERVICE_HOME/service/grogu/protected/maintain.ts" "$@"
    ;;
  *) exit 64 ;;
esac
SCRIPT
} > "$stage/maintain"

for target in runtime tunnel; do
  cat > "$stage/$target.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$label.$target</string>
<key>UserName</key><string>$service_user</string>
<key>GroupName</key><string>$service_user</string>
<key>WorkingDirectory</key><string>$service_home/service</string>
<key>ProgramArguments</key><array><string>/usr/bin/env</string><string>-i</string><string>HOME=$service_home</string><string>PATH=/usr/bin:/bin:/usr/sbin:/sbin</string><string>$helpers/$label-$target</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ProcessType</key><string>Background</string>
<key>ThrottleInterval</key><integer>30</integer>
<key>ExitTimeOut</key><integer>120</integer>
</dict></plist>
PLIST
  plutil -lint "$stage/$target.plist" >/dev/null
done
printf '%s\n' \
  "$operator ALL=(root) NOPASSWD: $helpers/$label-control" \
  "$operator ALL=($service_user) NOPASSWD: $helpers/$label-maintain" > "$stage/sudoers"
/usr/sbin/visudo -cf "$stage/sudoers" >/dev/null
for target in runtime tunnel control maintain; do
  /bin/sh -n "$stage/$target"
  install -o root -g wheel -m 755 "$stage/$target" "$helpers/$label-$target"
done
for target in runtime tunnel; do
  install -o root -g wheel -m 644 "$stage/$target.plist" "/Library/LaunchDaemons/$label.$target.plist"
done
install -o root -g wheel -m 440 "$stage/sudoers" "$sudoers"
cat "$tunnel_input" | as_service /usr/bin/cmp -s - "$service_home/secrets/tunnel-token"
cat "$sparky_input" | as_service /usr/bin/cmp -s - "$service_home/secrets/sparky-key"
/usr/bin/sudo -u "$operator" /bin/rm "$tunnel_input" "$sparky_input"
echo "Provisioned $service_user with private state. Neither service is active."
echo "Install the reviewed runtime, Node, dependencies, and configuration through the service account."
echo "Start only the prepared runtime and tunnel with $helpers/$label-control."
echo "The staging secret copies were removed after the isolated copies matched."
