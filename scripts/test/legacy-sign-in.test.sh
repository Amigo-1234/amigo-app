#!/bin/sh
# Exercise the legacy-sign-in Edge Function's failure paths (uses made-up emails only;
# never a real password). Expects a fresh rate-limit window for these test emails.
#
#   FN_URL=https://<ref>.supabase.co/functions/v1/legacy-sign-in KEY=<publishable key> sh scripts/test/legacy-sign-in.test.sh
#   FN_URL=http://localhost:8000 sh scripts/test/legacy-sign-in.test.sh          # local deno run
set -u
tag=$(date +%s)
fail=0
call() { curl -s -o /tmp/lsi.out -w "%{http_code}" -X POST "$FN_URL" -H 'content-type: application/json' \
  ${KEY:+-H "apikey: $KEY" -H "Authorization: Bearer $KEY"} -H "x-forwarded-for: $3" -d "{\"email\":\"$1\",\"password\":\"$2\"}"; }
expect() { got=$(call "$1" "$2" "$3"); body=$(cat /tmp/lsi.out)
  case "$got:$body" in *"$4"*) echo "ok   $5 ($got $body)";; *) echo "FAIL $5 (got $got $body, want $4)"; fail=1;; esac; }
for i in 1 2 3 4 5; do expect "nobody-$tag@example.com" "Wrong$i-pass" "10.0.$tag.1" no_match "unknown email attempt $i is generic"; done
expect "nobody-$tag@example.com" "Wrong6-pass" "10.0.$tag.1" rate_limited "6th attempt for one email is throttled"
expect "other-$tag@example.com" "Wrong-pass1" "10.0.$tag.2" no_match "other emails unaffected"
expect "" "" "10.0.$tag.3" no_match "empty input is generic"
[ $fail = 0 ] && echo "ALL LEGACY SIGN-IN TESTS PASSED" || { echo "LEGACY SIGN-IN TESTS FAILED"; exit 1; }
