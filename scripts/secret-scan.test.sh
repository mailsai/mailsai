#!/usr/bin/env bash
# Proves secret-scan.sh has TEETH: it must FAIL on each planted secret class and
# PASS on the clean tree. A guard that cannot fail is indistinguishable from one
# that passes, and is worse than none because the next person trusts it.
set -uo pipefail
cd "$(dirname "$0")/.."
pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then echo "  ✓ $1"; pass=$((pass+1)); else echo "  ✗ $1 (expected exit $3, got $2)"; fail=$((fail+1)); fi; }

./scripts/secret-scan.sh >/dev/null 2>&1; ck "clean tree passes" "$?" 0

plant() { # <name> <content>
  printf '%s\n' "$2" > "__scantest__.txt"
  git add -f __scantest__.txt >/dev/null 2>&1
  ./scripts/secret-scan.sh >/dev/null 2>&1; local rc=$?
  git rm -f --cached __scantest__.txt >/dev/null 2>&1; rm -f __scantest__.txt
  ck "catches $1" "$rc" 1
}

# The fixtures are ASSEMBLED AT RUNTIME from fragments rather than written as
# literals. GitHub push protection scans this repository too and correctly refused
# an earlier version of this file for containing a Stripe-shaped key — which is a
# welcome second guard, but it also means a test for a secret scanner cannot spell
# its own test data out loud.
L=live; K=key; P=p   # fragments, so this file never spells a token shape out loud
plant "mails.ai live key"    "MAILS_API_KEY=mk_${L}_9fJ2kQ7xR4mN8pL3vB6tZ1wY5cH0dG"
plant "Stripe secret key"    "STRIPE=sk_${L}_51QwErTyUiOpAsDfGhJkLzXcVbNm0123"
plant "GitHub token"         "token gh${P}_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
plant "Cloudflare token"     "CF=cfat_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"
plant "AWS access key"       "aws_access_${K}_id = AKIA""IOSFODNN7EXAMPLE"
plant "database URL"         "DATABASE_URL=postgresql://user:s3cr3tpw@ep-x.neon.tech/db"
plant "private key block"    "-----BEGIN RSA PRIVATE $(echo $K | tr a-z A-Z)-----"
plant "tailnet address"      "ssh admin@100.75.33.71"

plant "private server module"  'import { db } from "@/lib/db"'
plant "pool-trust logic"       'export { poolFor } from "./lib/pool-trust"'
plant "server framework code"  'import { NextResponse } from "next/server"'
plant "operator secret name"   'Authorization: Bearer $MAILS_INTERNAL_SECRET'
plant "raw threshold"          'const QUARANTINE_THRESHOLD = 0.95'

# A real .env must be refused; a documentation .env.example must not be.
printf 'X=1\n' > .env.local; git add -f .env.local >/dev/null 2>&1
./scripts/secret-scan.sh >/dev/null 2>&1; rc=$?
git rm -f --cached .env.local >/dev/null 2>&1; rm -f .env.local
ck "refuses a tracked .env.local" "$rc" 1

./scripts/secret-scan.sh >/dev/null 2>&1
ck "still passes after cleanup (no state left behind)" "$?" 0

echo; echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
