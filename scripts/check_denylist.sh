#!/usr/bin/env bash
set -euo pipefail

terms_file=.github/denylist.txt
if [[ ! -f "$terms_file" ]]; then
  echo "No deny-list configured; skipping."
  exit 0
fi

failed=0
while IFS= read -r term || [[ -n "$term" ]]; do
  [[ -z "$term" ]] && continue
  [[ "$term" == \#* ]] && continue
  if git grep --fixed-strings --ignore-case --line-number -- "$term" -- ':!.github/denylist.txt'; then
    failed=1
  fi
done < "$terms_file"

if (( failed )); then
  echo "Deny-list check failed."
  exit 1
fi
echo "Deny-list check passed."
