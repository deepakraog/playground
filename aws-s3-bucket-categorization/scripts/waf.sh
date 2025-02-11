#!/usr/bin/env bash

# List all Web ACLs in REGIONAL scope. Filter only those whose Description
# contains "Integration-PR". For each match, output Name and Id in a TSV format.
aws wafv2 list-web-acls \
  --scope REGIONAL \
  --query "WebACLs[?contains(@.Description, 'Integration-PR')].[Name,Id]" \
  --output text |
while read -r name id; do
  # Get the LockToken required for deletion
  lockToken=$(aws wafv2 get-web-acl \
    --name "$name" \
    --id "$id" \
    --scope REGIONAL \
    --query "LockToken" \
    --output text)

  echo "Deleting Web ACL: $name (Id: $id, LockToken: $lockToken)"

  # Delete the Web ACL
  aws wafv2 delete-web-acl \
    --name "$name" \
    --id "$id" \
    --scope REGIONAL \
    --lock-token "$lockToken"
done
