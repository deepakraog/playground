#!/usr/bin/env bash
#
# Usage:
#   ./delete-matching-tables.sh [MATCH_PATTERN] [SKIP_PATTERN]
#
# MATCH_PATTERN: regex of table names to delete. Default: Integration-PR4
# SKIP_PATTERN : regex of table names to skip. If empty, does not skip any.
#
# Example: 
#   ./delete-matching-tables.sh "Integration-PR4" "Integration-PR459"
#   (Deletes all tables matching Integration-PR4 except those matching Integration-PR459)
# 
#   ./delete-matching-tables.sh "Integration-PR4" "Integration-PR459|Integration-PR460"
#   (Deletes all tables matching Integration-PR4 except PR459 and PR460)

set -euo pipefail

MATCH_PATTERN="${1:-Integration-PR1}"
SKIP_PATTERN="${2:-Integration-PR459}"

aws dynamodb list-tables --output json \
  | jq -r ".TableNames[] | select(test(\"$MATCH_PATTERN\"))" \
  | while read -r TABLE_NAME; do

      # If a skip pattern is set, skip the table if it matches
      if [[ -n "$SKIP_PATTERN" && "$TABLE_NAME" =~ $SKIP_PATTERN ]]; then
        continue
      fi

      echo "==> Deleting table: $TABLE_NAME"
      
      # Disable deletion protection if enabled, ignore error if already disabled
      aws dynamodb update-table \
        --table-name "$TABLE_NAME" \
        --no-deletion-protection-enabled \
        >/dev/null 2>&1 || true

      # Delete the table, ignore error if it's already in DELETING status, etc.
      aws dynamodb delete-table \
        --table-name "$TABLE_NAME" \
        >/dev/null 2>&1 || true

      echo "==> Table deleted: $TABLE_NAME"
    done


echo "All matching tables processed."
