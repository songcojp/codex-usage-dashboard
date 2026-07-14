#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ca_cert="$repo_root/deploy/certs/caddy-root.crt"
dry_run=0

usage() {
  cat <<'USAGE'
Usage: scripts/install-ca-trust.sh [--dry-run]

Installs deploy/certs/caddy-root.crt into the Linux operating-system trust store.
Run this script directly on each workstation whose browsers should trust the dashboard.
USAGE
}

fail() { echo "$1" >&2; exit "${2:-1}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1" 2 ;;
  esac
done

command -v openssl >/dev/null 2>&1 || fail "openssl is required but was not found in PATH" 2
[[ -f "$ca_cert" ]] || fail "CA certificate is missing: $ca_cert" 2

if grep -Eiq -- '-----BEGIN [^-]*PRIVATE KEY-----' "$ca_cert"; then
  fail "CA certificate is invalid: private-key material is not allowed" 2
fi
[[ "$(grep -c '^-----BEGIN CERTIFICATE-----$' "$ca_cert" || true)" -eq 1 ]] || fail "CA certificate is invalid: expected exactly one certificate" 2
[[ "$(grep -c '^-----END CERTIFICATE-----$' "$ca_cert" || true)" -eq 1 ]] || fail "CA certificate is invalid: expected exactly one certificate" 2
if sed '/^-----BEGIN CERTIFICATE-----$/,/^-----END CERTIFICATE-----$/d' "$ca_cert" | grep -q '[^[:space:]]'; then
  fail "CA certificate is invalid: unexpected content outside the certificate" 2
fi
openssl x509 -in "$ca_cert" -noout -checkend 0 >/dev/null 2>&1 || fail "CA certificate is invalid or expired: $ca_cert" 2
openssl x509 -in "$ca_cert" -noout -text | grep -Eq 'CA:[[:space:]]*TRUE' || fail "CA certificate is not a CA: $ca_cert" 2
fingerprint="$(openssl x509 -in "$ca_cert" -noout -fingerprint -sha256 | sed 's/^sha256 Fingerprint=//; s/^SHA256 Fingerprint=//')"

backend="${CODEX_USAGE_DASHBOARD_TEST_CA_BACKEND:-}"
if [[ -z "$backend" ]]; then
  if command -v update-ca-certificates >/dev/null 2>&1; then
    backend="debian"
  elif command -v update-ca-trust >/dev/null 2>&1; then
    backend="rhel"
  else
    backend="unsupported"
  fi
fi

case "$backend" in
  debian)
    destination="/usr/local/share/ca-certificates/codex-usage-dashboard.crt"
    refresh=(update-ca-certificates)
    ;;
  rhel)
    destination="/etc/pki/ca-trust/source/anchors/codex-usage-dashboard.crt"
    refresh=(update-ca-trust extract)
    ;;
  *)
    fail "Unsupported Linux certificate trust backend; install update-ca-certificates or update-ca-trust" 2
    ;;
esac

if [[ "$dry_run" -eq 1 ]]; then
  echo "CA fingerprint: $fingerprint"
  echo "Would install: $ca_cert -> $destination"
  echo "Would run: ${refresh[*]}"
  echo "Restart all browser processes after installation."
  exit 0
fi

run_as_root() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    "$@"
  else
    command -v sudo >/dev/null 2>&1 || fail "sudo is required to update the system trust store" 2
    sudo -- "$@"
  fi
}

run_as_root install -m 0644 "$ca_cert" "$destination"
run_as_root "${refresh[@]}"
cmp -s "$ca_cert" "$destination" || fail "Installed CA certificate does not match the repository certificate"

echo "Installed operating-system CA trust: $fingerprint"
echo "Restart all browser processes before opening the dashboard."
