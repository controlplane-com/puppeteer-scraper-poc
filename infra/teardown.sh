#!/usr/bin/env bash
# Tear down everything deploy.sh creates:
#
#   1. All workloads in the puppeteer-scraper-poc GVC
#      (webapp, processor, plus any cpln-run-<hash> cron workloads that
#       `cpln workload cron run` provisioned)
#   2. The GVC itself — which also removes webapp-identity
#   3. The two org-scoped policies
#   4. The three pushed images
#
# Every delete is guarded by an existence check, so rerunning this after a
# partial teardown is safe. Bypass the interactive prompt with `YES=1`.

set -euo pipefail

# Always operate from the project root, no matter where the caller runs us from.
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_ROOT}"

if [ -f .env ]; then
  set -a; source .env; set +a
fi

: "${CPLN_ORG:?set CPLN_ORG in .env or the environment}"
CPLN_PROFILE="${CPLN_PROFILE:-}"
GVC="puppeteer-scraper-poc"
POLICIES=(webapp-can-run-scraper-cron webapp-gvc-view)
IMAGES=(
  puppeteer-scraper-poc-webapp:latest
  puppeteer-scraper-poc-scraper:latest
  puppeteer-scraper-poc-processor:latest
)

echo ">> org=${CPLN_ORG} gvc=${GVC} profile=${CPLN_PROFILE:-<default>}"

# ── cpln wrapper ────────────────────────────────────────────────────
#
# Wraps cpln so we append --profile only when CPLN_PROFILE is set.
run_cpln() {
  if [ -n "${CPLN_PROFILE}" ]; then
    cpln "$@" --profile "${CPLN_PROFILE}"
  else
    cpln "$@"
  fi
}

# ── existence check ─────────────────────────────────────────────────
#
# `resource_exists KIND NAME [extra-flags...]` returns 0 if `cpln KIND get`
# succeeds. Keeps every delete step idempotent.
resource_exists() {
  local kind="$1" name="$2"
  shift 2
  run_cpln "${kind}" get "${name}" "$@" >/dev/null 2>&1
}

# ── confirmation ────────────────────────────────────────────────────

if [ "${YES:-0}" != "1" ]; then
  cat <<EOF

This will permanently delete the following in org '${CPLN_ORG}':

  GVC:      ${GVC}
            (and all workloads + webapp-identity inside it)
  Policies: ${POLICIES[*]}
  Images:   ${IMAGES[*]}

EOF
  read -r -p "Proceed? [y/N] " answer
  case "${answer}" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 0 ;;
  esac
fi

# ── teardown ────────────────────────────────────────────────────────

echo ""
echo "=== Step 1/4: Delete all workloads in ${GVC} ==="
# Clears webapp, processor, and any ephemeral cpln-run-<hash> cron workloads.
# Must happen before `gvc delete`.
if resource_exists gvc "${GVC}" --org "${CPLN_ORG}"; then
  run_cpln gvc delete-all-workloads "${GVC}" --org "${CPLN_ORG}" || true
else
  echo ">> gvc '${GVC}' does not exist — skipping"
fi

echo ""
echo "=== Step 2/4: Delete GVC ${GVC} ==="
# Removes the GVC and — by cascade — the webapp-identity inside it.
if resource_exists gvc "${GVC}" --org "${CPLN_ORG}"; then
  run_cpln gvc delete "${GVC}" --org "${CPLN_ORG}"
else
  echo ">> gvc '${GVC}' does not exist — skipping"
fi

echo ""
echo "=== Step 3/4: Delete policies ==="
# Org-scoped — not cleaned up by the GVC delete.
for policy in "${POLICIES[@]}"; do
  if resource_exists policy "${policy}" --org "${CPLN_ORG}"; then
    run_cpln policy delete "${policy}" --org "${CPLN_ORG}"
  else
    echo ">> policy '${policy}' does not exist — skipping"
  fi
done

echo ""
echo "=== Step 4/4: Delete images ==="
# Org-scoped — the next deploy.sh will rebuild them.
for image in "${IMAGES[@]}"; do
  if resource_exists image "${image}" --org "${CPLN_ORG}"; then
    run_cpln image delete "${image}" --org "${CPLN_ORG}"
  else
    echo ">> image '${image}' does not exist — skipping"
  fi
done

echo ""
echo "Done. Rerun ./infra/deploy.sh to recreate."
