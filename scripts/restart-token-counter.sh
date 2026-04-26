#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="opencode-context-compression-token-counter.service"
HEALTH_URL="http://127.0.0.1:40311/health"

systemctl restart "${SERVICE_NAME}"

for _ in {1..20}; do
  if python - <<'PY' >/dev/null 2>&1
import urllib.request
urllib.request.urlopen("http://127.0.0.1:40311/health", timeout=1).read()
PY
  then
    systemctl status "${SERVICE_NAME}" --no-pager
    python - <<'PY'
import urllib.request
print(urllib.request.urlopen("http://127.0.0.1:40311/health", timeout=1).read().decode())
PY
    exit 0
  fi
  sleep 0.25
done

systemctl status "${SERVICE_NAME}" --no-pager
echo "Token counter did not become healthy at ${HEALTH_URL}" >&2
exit 1
