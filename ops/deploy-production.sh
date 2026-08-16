#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

readonly app_user="ubuntu"
readonly app_group="ubuntu"
readonly app_home="/home/ubuntu"
readonly current_entry="$app_home/bubblewash-pilot"
readonly releases_dir="$app_home/bubblewash-releases"
readonly rollbacks_dir="$app_home/bubblewash-rollbacks"
readonly runtime_dir="$app_home/bubblewash-runtime"
readonly env_file="$app_home/.config/bubblewash/env"
readonly service_name="bubblewash-local.service"

release_dir="${1:-}"
deploy_sha="${2:-}"

fail() {
  echo "Deployment failed: $*" >&2
  exit 1
}

[[ "${EUID:-$(id -u)}" -eq 0 ]] || fail "run this script as root"
[[ "$deploy_sha" =~ ^[0-9a-f]{40}$ ]] || fail "the deployment SHA is invalid"
case "$release_dir" in
  "$releases_dir"/*) ;;
  *) fail "the release directory is outside $releases_dir" ;;
esac

release_id="$(basename -- "$release_dir")"
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$ ]] || fail "the release directory name is invalid"
[[ "${release_id##*-}" == "${deploy_sha:0:12}" ]] || fail "the release directory does not match the deployment SHA"
[[ -d "$release_dir" ]] || fail "the release directory is missing"
[[ -f "$release_dir/package-lock.json" ]] || fail "package-lock.json is missing from the release"
[[ -f "$release_dir/ops/deploy-production.sh" ]] || fail "the deployment script is missing from the release"
[[ -f "$env_file" ]] || fail "the production environment file is missing"

install -d -o "$app_user" -g "$app_group" -m 0750 "$releases_dir" "$rollbacks_dir"
install -d -o "$app_user" -g "$app_group" -m 0700 "$runtime_dir"
chown -R "$app_user:$app_group" "$release_dir"

exec 9>"$runtime_dir/deploy.lock"
flock -n 9 || fail "another production deployment is already running"

app_uid="$(id -u "$app_user")"

userctl() {
  runuser -u "$app_user" -- env \
    XDG_RUNTIME_DIR="/run/user/$app_uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$app_uid/bus" \
    systemctl --user "$@"
}

run_transient() {
  local unit_name="$1"
  local working_directory="$2"
  shift 2
  systemd-run \
    --quiet \
    --wait \
    --collect \
    --pipe \
    --unit="$unit_name" \
    --property="User=$app_user" \
    --property="Group=$app_group" \
    --property="WorkingDirectory=$working_directory" \
    --property="EnvironmentFile=$env_file" \
    --property="Environment=HOME=$app_home" \
    "$@"
}

wait_for_route() {
  local url="$1"
  local service_unit="${2:-}"
  local attempt
  for attempt in $(seq 1 45); do
    if curl --fail --silent --show-error --max-time 5 --output /dev/null "$url"; then
      return 0
    fi
    if [[ -n "$service_unit" ]] && ! systemctl is-active --quiet "$service_unit"; then
      return 1
    fi
    sleep 2
  done
  return 1
}

smoke_routes() {
  local origin="$1"
  local path
  for path in / /services /book /track /manage /early-access /api/health /api/ready; do
    curl \
      --fail \
      --silent \
      --show-error \
      --location \
      --max-time 10 \
      --output /dev/null \
      "$origin$path"
  done
}

userctl is-active --quiet "$service_name" || fail "$service_name is not active before deployment"

echo "Building Bubble Wash release ${deploy_sha:0:12}."
run_transient \
  "bubblewash-build-$release_id" \
  "$release_dir" \
  /bin/bash -c \
  'export NEXT_TELEMETRY_DISABLED=1; npm ci --no-audit --no-fund; npm run build; npm prune --omit=dev --no-audit --no-fund'

[[ -f "$release_dir/.next/BUILD_ID" ]] || fail "the Next.js build did not produce a BUILD_ID"
[[ -x "$release_dir/node_modules/.bin/next" ]] || fail "the Next.js runtime is missing"

current_target="$(readlink -f -- "$current_entry")"
[[ -d "$current_target" ]] || fail "the current production release is missing"

echo "Creating and restore-verifying the encrypted production database backup."
run_transient \
  "bubblewash-backup-$release_id" \
  "$release_dir" \
  /usr/bin/npm run db:backup

preflight_unit="bubblewash-preflight-$release_id.service"
preflight_started=false

cleanup_preflight() {
  if [[ "$preflight_started" == true ]]; then
    systemctl stop "$preflight_unit" >/dev/null 2>&1 || true
  fi
}
trap cleanup_preflight EXIT

if ss -lnt | grep -qE '127\.0\.0\.1:3001([[:space:]]|$)'; then
  fail "the preflight port 3001 is already in use"
fi

echo "Starting an isolated preflight server on port 3001."
systemd-run \
  --quiet \
  --collect \
  --unit="$preflight_unit" \
  --property="User=$app_user" \
  --property="Group=$app_group" \
  --property="WorkingDirectory=$release_dir" \
  --property="EnvironmentFile=$env_file" \
  --property="Environment=HOME=$app_home" \
  --property="RuntimeMaxSec=180" \
  /bin/bash -c 'exec ./node_modules/.bin/next start -H 127.0.0.1 -p 3001'
preflight_started=true

if ! wait_for_route "http://127.0.0.1:3001/api/ready" "$preflight_unit"; then
  curl --silent --show-error --max-time 5 "http://127.0.0.1:3001/api/ready" || true
  systemctl status "$preflight_unit" --no-pager || true
  journalctl --unit="$preflight_unit" --lines=80 --no-pager || true
  fail "the candidate release did not become ready"
fi
smoke_routes "http://127.0.0.1:3001"
systemctl stop "$preflight_unit"
preflight_started=false

previous_target="$current_target"
previous_was_symlink=false
if [[ -L "$current_entry" ]]; then
  previous_was_symlink=true
elif [[ -d "$current_entry" ]]; then
  previous_target="$rollbacks_dir/pre-actions-$release_id"
  [[ ! -e "$previous_target" ]] || fail "the initial rollback directory already exists"
else
  fail "$current_entry is neither a directory nor a symbolic link"
fi

service_stopped=false
switched=false
current_moved=false

rollback_on_error() {
  local exit_code=$?
  trap - ERR
  echo "The new release failed; restoring the previous production release." >&2

  if [[ "$switched" == true ]]; then
    userctl stop "$service_name" >/dev/null 2>&1 || true
    if [[ "$previous_was_symlink" == true ]]; then
      local restore_link="$app_home/.bubblewash-restore-$release_id"
      ln -s "$previous_target" "$restore_link"
      chown -h "$app_user:$app_group" "$restore_link"
      mv -Tf "$restore_link" "$current_entry"
    else
      unlink "$current_entry"
      mv "$previous_target" "$current_entry"
    fi
    userctl start "$service_name" || true
  elif [[ "$service_stopped" == true ]]; then
    if [[ "$current_moved" == true ]]; then
      mv "$previous_target" "$current_entry"
    fi
    userctl start "$service_name" || true
  fi

  if [[ -L "$candidate_link" ]]; then
    unlink "$candidate_link"
  fi

  exit "$exit_code"
}
trap rollback_on_error ERR

candidate_link="$app_home/.bubblewash-release-$release_id"
[[ ! -e "$candidate_link" && ! -L "$candidate_link" ]] || fail "the candidate release link already exists"
ln -s "$release_dir" "$candidate_link"
chown -h "$app_user:$app_group" "$candidate_link"

echo "Switching the production service to release ${deploy_sha:0:12}."
userctl stop "$service_name"
service_stopped=true

if [[ "$previous_was_symlink" == false ]]; then
  mv "$current_entry" "$previous_target"
  current_moved=true
fi
mv -Tf "$candidate_link" "$current_entry"
switched=true

userctl start "$service_name"
service_stopped=false

wait_for_route "http://127.0.0.1:3000/api/ready"
smoke_routes "http://127.0.0.1:3000"

status_path="$runtime_dir/current-release"
temporary_status="$status_path.$$.tmp"
printf 'sha=%s\nrelease=%s\npath=%s\n' "$deploy_sha" "$release_id" "$release_dir" > "$temporary_status"
chown "$app_user:$app_group" "$temporary_status"
chmod 0600 "$temporary_status"
mv "$temporary_status" "$status_path"

trap - ERR
echo "Bubble Wash release $deploy_sha is healthy on production."
