#!/usr/bin/env bash
# Refuse to let anything credential-shaped, or anything naming our internal
# infrastructure, exist in this PUBLIC repository.
#
# WHY THIS EXISTS (2026-09-04). This repo is the public mirror of the private
# the private product repo, and both hold a directory at the SAME internal path,
# `packages/mcp-server`, with near-identical files. There is no sync script — the
# mirror is updated by hand — so the update gesture is "copy the files across",
# performed by a person or an agent looking at two directories that appear
# identical. One wrong source directory publishes private content.
#
# The npm side of that gesture is already contained: package.json carries
# `files: ["dist","README.md","LICENSE"]`, an ALLOWLIST, which is why publishing
# from the private tree shipped nothing extra even when it was done with
# --ignore-scripts. The git side had no equivalent, so this is it.
#
# Deliberately pattern-based and dependency-free: it must keep working years from
# now with no action to install and nothing to expire.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
hit() { printf '  ✗ %s\n     %s\n' "$1" "$2"; fail=1; }

# Length/charset floors below are what keep documentation placeholders passing:
# README.md legitimately shows `mk_live_or_test_xxx`, which must NOT trip this.
scan() { # <label> <extended-regex>
  local label="$1" re="$2" out
  out=$(git grep -nIaE "$re" -- . ':(exclude)scripts/secret-scan.sh' ':(exclude)scripts/secret-scan.test.sh' 2>/dev/null | head -3)
  [ -n "$out" ] && hit "$label" "$(echo "$out" | head -1 | cut -c1-160)"
}

scan "mails.ai live API key"   'mk_live_[A-Za-z0-9]{16,}'
scan "Stripe secret key"       '(sk|rk)_live_[A-Za-z0-9]{16,}'
scan "GitHub token"            '(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})'
scan "Cloudflare API token"    'cfat_[A-Za-z0-9_-]{20,}'
scan "AWS access key id"       'AKIA[0-9A-Z]{16}'
scan "database URL with creds" '(postgres|postgresql|mysql|mongodb(\+srv)?)://[^:/ ]+:[^@ ]+@'
scan "private key block"       'BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY'
# NB: no \b here — BSD grep -E does not support it, and using it made this
# single check silently never fire while every other one worked.
# --- Private product logic ------------------------------------------------
# The credential checks above answer "did a key leak". These answer the question
# that actually matters for this repo: "did a file from the PRIVATE product tree
# get copied in here". What is public is deliberately CLIENT code — it ships the
# firewall's verdict (`quarantined`) and its evidence (`injection_score`) but
# never the decision boundary, which lives server-side in lib/classifier.ts. See
# the comment at packages/mcp-server/src/demo.ts:195, which withholds the
# threshold on purpose. Detection logic is the one thing an abuser genuinely
# benefits from reading, so it must never appear here.
scan "private server module"   '(from|require\() *["'"'"'][^"'"'"']*(@/lib/|lib/(classifier|pool-trust|internal-workspaces|db))'
scan "server-side framework"   '(drizzle-orm|export const dynamic *= *"force-dynamic"|next/server)'
scan "internal operator secret" 'MAILS_INTERNAL_SECRET'
scan "raw quarantine threshold" '(QUARANTINE_THRESHOLD|HOLD_LINE|quarantine_threshold) *[=:] *0\.[0-9]'

scan "tailnet address"         '(^|[^0-9.])100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}([^0-9.]|$)'

# THE EXCLUSION ABOVE IS A BLIND SPOT — close it. Every scan() skips this file and the
# test file, because they must contain the patterns they hunt for. That is necessary and
# it is also exactly where a real secret can hide unseen: on 2026-09-09 a REAL fleet host
# and username sat in the test's tailnet fixture, published on this public repo by the
# very test written to keep such things out, and no scan could ever have caught it.
# So scan those two files too, narrowly: a fleet address is refused unless it is in the
# documentation placeholder range 100.64.0.x, which is unassigned.
fixture_out=$(grep -nE '(^|[^0-9.])100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}([^0-9.]|$)' \
                scripts/secret-scan.sh scripts/secret-scan.test.sh 2>/dev/null \
              | grep -vE '100\.64\.0\.[0-9]{1,3}' | head -3)
[ -n "$fixture_out" ] && hit "real tailnet address in a scanner fixture" "$(echo "$fixture_out" | head -1 | cut -c1-160)"

# An .env should never be tracked here at all, whatever it happens to contain.
# `.env.example` / `.sample` / `.template` are documentation and are allowed;
# a real `.env`, or `.env.local`/`.env.production`, never is.
# Portable on BSD and GNU grep alike: -P is NOT available on macOS, and using it
# made this check pass VACUOUSLY (grep errored, the pipeline reported clean).
env_tracked=$(git ls-files \
  | grep -E '(^|/)\.env($|\.)' \
  | grep -vE '\.(example|sample|template)$' \
  | head -3)
[ -n "$env_tracked" ] && hit "tracked .env file" "$env_tracked"

if [ "$fail" -ne 0 ]; then
  echo
  echo "Secret scan FAILED — this is the public mirror; do not push the above."
  exit 1
fi
echo "✓ secret scan clean"
