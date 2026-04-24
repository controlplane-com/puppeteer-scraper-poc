#!/usr/bin/env bash
# Build + push three images, apply infra, and bring workloads up.
#
# Workload apply strategy (per workload, independently):
#   - First creation: `cpln apply --ready` so we block until the new replica
#     is healthy. No force-redeployment — the replica is already running the
#     image we just pushed.
#   - Already exists:  `cpln apply` (no --ready, typically a no-op since the
#     spec hasn't changed) then `cpln workload force-redeployment` so replicas
#     pull the newly-pushed :latest image.
#
# Auth: uses your local cpln profile (run `cpln login` once). Set CPLN_PROFILE
# in .env to pick a specific profile. CPLN_ORG is always passed explicitly so
# the profile's default org doesn't silently take over.

set -euo pipefail

# Always operate from the project root, no matter where the caller runs us
# from (project root, infra/, an absolute path, sourced, symlinked, etc.).
# BASH_SOURCE[0] is the canonical script path; `cd && pwd` resolves it to
# an absolute directory. Works from any cwd.
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_ROOT}"

if [ -f .env ]; then
  set -a; source .env; set +a
fi

: "${CPLN_ORG:?set CPLN_ORG in .env or the environment}"
CPLN_PROFILE="${CPLN_PROFILE:-}"
GVC="puppeteer-scraper-poc"

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

# ── image build ─────────────────────────────────────────────────────

build_and_push() {
  local name="$1" dir="$2"
  echo ">> building ${name}:latest from ${dir}/"
  run_cpln image build \
    --name "${name}:latest" \
    --dir "${dir}" \
    --push \
    --org "${CPLN_ORG}"
}

# ── manifest apply ──────────────────────────────────────────────────
#
# `apply_manifest` — used for fast, non-workload resources (gvc, identity,
# policies). cpln apply is idempotent, so this works for both create and update.
apply_manifest() {
  local file="$1"
  echo ">> applying ${file}"
  run_cpln apply --file "${file}" --org "${CPLN_ORG}"
}

# ── workload-aware apply ────────────────────────────────────────────
#
# Returns 0 if the named workload already exists in GVC, non-zero otherwise.
workload_exists() {
  local name="$1"
  run_cpln workload get "${name}" \
    --gvc "${GVC}" --org "${CPLN_ORG}" \
    >/dev/null 2>&1
}

# Apply a workload manifest using the right strategy for the situation.
# See the comment at the top of this file for the create-vs-update rationale.
apply_workload() {
  local name="$1" file="$2"

  if workload_exists "${name}"; then
    echo ">> workload '${name}' exists — applying spec + forcing redeployment"
    run_cpln apply --file "${file}" --gvc "${GVC}" --org "${CPLN_ORG}"
    run_cpln workload force-redeployment "${name}" \
      --gvc "${GVC}" --org "${CPLN_ORG}"
  else
    echo ">> workload '${name}' does not exist — creating and waiting for ready"
    run_cpln apply --file "${file}" --gvc "${GVC}" --org "${CPLN_ORG}" --ready
  fi
}

# ── execute ─────────────────────────────────────────────────────────

echo ""
echo "=== Step 1/3: Build + push images ==="
build_and_push puppeteer-scraper-poc-webapp    webapp
build_and_push puppeteer-scraper-poc-scraper   scraper
build_and_push puppeteer-scraper-poc-processor processor

echo ""
echo "=== Step 2/3: Apply GVC + identity + policies ==="
apply_manifest infra/gvc.yaml
apply_manifest infra/identity.yaml
apply_manifest infra/policy.yaml
apply_manifest infra/policy-gvc.yaml

echo ""
echo "=== Step 3/3: Apply workloads ==="
apply_workload webapp   infra/webapp.yaml
apply_workload processor infra/processor.yaml

# ── endpoint ────────────────────────────────────────────────────────

echo ""
echo "=== Webapp endpoint ==="
if command -v jq >/dev/null 2>&1; then
  endpoint="$(run_cpln workload get webapp --gvc "${GVC}" --org "${CPLN_ORG}" -o json \
    | jq -r '.status.endpoint // empty')"
else
  endpoint="$(run_cpln workload get webapp --gvc "${GVC}" --org "${CPLN_ORG}" -o json \
    | grep -o '"endpoint"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -1 \
    | sed 's/.*"\([^"]*\)"$/\1/')"
fi
echo "webapp: ${endpoint:-<not ready yet — rerun cpln workload get webapp>}"
