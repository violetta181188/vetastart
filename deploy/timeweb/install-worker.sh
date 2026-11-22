#!/usr/bin/env bash
set -euo pipefail
umask 077

ref=""; dry_run=false
while (($#)); do
  case "$1" in
    --ref) ref="${2:?Commit SHA required}"; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    *) echo "Usage: install-worker.sh --ref COMMIT_SHA [--dry-run]" >&2; exit 2 ;;
  esac
done
[[ "$ref" =~ ^[a-f0-9]{40}$ ]] || { echo 'A reviewed 40-character commit SHA is required.' >&2; exit 2; }
if "$dry_run"; then
  echo "Plan: isolated Node 24 worker from commit $ref, under /opt/vetastart-worker."
  echo 'Private environment: /etc/vetastart-worker/worker.env; service: vetastart-worker.'
  echo 'Existing website, nginx, DNS and paid resources are not changed. Sending remains OFF.'
  exit 0
fi
[[ "$EUID" == 0 ]] || { echo 'Run this installer from the owner VPS root console.' >&2; exit 1; }
[[ -d /run/systemd/system ]] || { echo 'A running systemd host is required.' >&2; exit 1; }
for command in curl python3 tar xz sha256sum systemctl useradd getent; do
  command -v "$command" >/dev/null || { echo "Required command missing: $command" >&2; exit 1; }
done
python3 - <<'PY'
import os
memory = {line.split(':', 1)[0]: int(line.split()[1]) for line in open('/proc/meminfo') if ':' in line}
disk = os.statvfs('/opt')
if memory.get('MemAvailable', 0) < 384 * 1024 or disk.f_bavail * disk.f_frsize < 768 * 1024 * 1024:
    raise SystemExit('Insufficient free RAM or disk for isolated worker installation; no resource changes made.')
PY
base=/opt/vetastart-worker
if [[ -e "$base" && ! -f "$base/.managed-by-vetastart" ]]; then
  echo 'Target directory exists without the worker marker; no changes made.' >&2; exit 1
fi
if getent passwd vetastart-worker >/dev/null && [[ ! -f "$base/.managed-by-vetastart" ]]; then
  echo 'Service user already exists without a managed worker; review required.' >&2; exit 1
fi
install -d -m 755 "$base" "$base/releases"
touch "$base/.managed-by-vetastart"
install -d -m 700 /etc/vetastart-worker
staging="$(mktemp -d "$base/.install-XXXXXX")"
trap 'rm -rf -- "$staging"' EXIT
case "$(uname -m)" in
  x86_64) arch=x64; node_sha=4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb ;;
  aarch64) arch=arm64; node_sha=6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c ;;
  *) echo 'Unsupported host architecture.' >&2; exit 1 ;;
esac
node_name="node-v24.22.3-linux-$arch"
if [[ ! -d "$base/$node_name" ]]; then
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fLsS --max-time 180 \
    "https://nodejs.org/dist/v24.22.3/$node_name.tar.xz" -o "$staging/node.tar.xz"
  printf '%s  %s\n' "$node_sha" "$staging/node.tar.xz" | sha256sum -c -
  tar -xJf "$staging/node.tar.xz" -C "$staging"
  chmod -R a+rX "$staging/$node_name"
  mv "$staging/$node_name" "$base/$node_name"
fi
ln -sfn "$node_name" "$base/node"
export PATH="$base/node/bin:$PATH"
release="$base/releases/$ref"
if [[ ! -d "$release" ]]; then
  mkdir "$staging/release"
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fLsS --max-time 180 \
    "https://api.github.com/repos/violetta181188/vetastart/tarball/$ref" -o "$staging/source.tar.gz"
  tar -xzf "$staging/source.tar.gz" --strip-components=1 -C "$staging/release"
  (cd "$staging/release"; npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
  chmod -R a+rX "$staging/release"
  mv "$staging/release" "$release"
fi
if ! getent passwd vetastart-worker >/dev/null; then
  useradd --system --home-dir "$base" --shell /usr/sbin/nologin vetastart-worker
fi
old_release="$(readlink "$base/current" || true)"
had_env=false; was_active=false
[[ ! -f /etc/vetastart-worker/worker.env ]] || { had_env=true; cp -p /etc/vetastart-worker/worker.env "$staging/previous.env"; }
systemctl is-active --quiet vetastart-worker && was_active=true
python3 "$release/deploy/timeweb/build_worker_env.py" --release "$release" \
  --node "$base/node/bin/node" --output /etc/vetastart-worker/worker.env
ln -sfn "releases/$ref" "$base/current"
install -m 644 "$release/deploy/timeweb/vetastart-worker.service" /etc/systemd/system/vetastart-worker.service
systemctl daemon-reload
start_ok=true
systemctl restart vetastart-worker || start_ok=false
sleep 3
if ! "$start_ok" || ! systemctl is-active --quiet vetastart-worker; then
  systemctl stop vetastart-worker || true
  if [[ -n "$old_release" ]]; then ln -sfn "$old_release" "$base/current"; fi
  if "$had_env"; then cp -p "$staging/previous.env" /etc/vetastart-worker/worker.env; fi
  if "$was_active"; then systemctl restart vetastart-worker; fi
  echo 'New worker did not start. The existing website was not changed.' >&2
  exit 1
fi
systemctl enable vetastart-worker
echo 'VetaStart worker is running. Sending remains OFF.'
echo 'Share only the service status; do not share worker.env or API keys.'
