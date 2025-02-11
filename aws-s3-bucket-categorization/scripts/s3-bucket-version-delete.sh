#!/usr/bin/env bash

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 \"bucket1,bucket2,bucket3\""
  exit 1
fi

buckets="$1"
MAX_RETRIES=5  # Prevent infinite loop if AWS API gets stuck

# Split comma-separated bucket names into an array
IFS=',' read -ra bucket_array <<< "$buckets"
IFS=' '  # Reset IFS

for BUCKET in "${bucket_array[@]}"; do
  BUCKET="$(echo "$BUCKET" | xargs)"  # Trim whitespace
  [ -z "$BUCKET" ] && continue  # Skip empty values

  echo "📌 Cleaning up bucket: $BUCKET"

  # **Step 1: Delete all standard objects (before versions)**
  retries=0
  while true; do
    tmp_list="$(mktemp)"
    aws s3api list-objects-v2 --bucket "$BUCKET" --query "Contents[*].Key" --output json > "$tmp_list" || true

    object_count=$(jq 'length' "$tmp_list" 2>/dev/null || echo 0)

    # If no objects exist, exit the loop
    if [ "$object_count" -eq 0 ]; then
      echo "✅ No standard objects left in $BUCKET."
      rm -f "$tmp_list"
      break
    fi

    echo "🗑️ Deleting $object_count standard objects..."
    
    # Delete objects in parallel
    jq -r '.[]? | select(. != null) | "aws s3api delete-object --bucket '"$BUCKET"' --key \"" + . + "\""' "$tmp_list" | bash >/dev/null 2>&1
    rm -f "$tmp_list"

    ((retries++))
    if [ "$retries" -ge "$MAX_RETRIES" ]; then
      echo "🚨 Too many retries deleting standard objects. Exiting..."
      exit 1
    fi

    sleep 2  # Avoid AWS rate limiting
  done

  # **Step 2: Delete all object versions & delete markers (paginated)**
  retries=0
  while true; do
    tmp_list="$(mktemp)"
    aws s3api list-object-versions --bucket "$BUCKET" --output json \
      --query '{Objects: Versions[?Key!=null][], DeleteMarkers: DeleteMarkers[?Key!=null][]}' > "$tmp_list" || true

    version_count=$(jq '[.Objects, .DeleteMarkers] | add | length' "$tmp_list" 2>/dev/null || echo 0)

    # If no versions exist, exit the loop
    if [ "$version_count" -eq 0 ]; then
      echo "✅ No object versions or delete markers left in $BUCKET."
      rm -f "$tmp_list"
      break
    fi

    echo "🗑️ Deleting $version_count object versions and delete markers..."
    
    jq -r '.Objects[]?, .DeleteMarkers[]? | select(.Key != null) | 
      "aws s3api delete-object --bucket '"$BUCKET"' --key \"" + .Key + "\" --version-id \"" + .VersionId + "\""' "$tmp_list" | bash >/dev/null 2>&1
    rm -f "$tmp_list"

    ((retries++))
    if [ "$retries" -ge "$MAX_RETRIES" ]; then
      echo "🚨 Too many retries deleting versions. Exiting..."
      exit 1
    fi

    sleep 2  # Avoid AWS rate limiting
  done

  # **Step 3: Delete unfinished multipart uploads**
  retries=0
  while true; do
    tmp_multipart="$(mktemp)"
    aws s3api list-multipart-uploads --bucket "$BUCKET" --output json > "$tmp_multipart" || true

    upload_count=$(jq '.Uploads | length' "$tmp_multipart" 2>/dev/null || echo 0)

    # If no uploads exist, exit the loop
    if [ "$upload_count" -eq 0 ]; then
      echo "✅ No active multipart uploads in $BUCKET."
      rm -f "$tmp_multipart"
      break
    fi

    echo "🛑 Aborting $upload_count multipart uploads..."
    
    jq -c '.Uploads[]? | {Key: .Key, UploadId: .UploadId}' "$tmp_multipart" | while read -r upload; do
      key=$(echo "$upload" | jq -r '.Key')
      upload_id=$(echo "$upload" | jq -r '.UploadId')
      aws s3api abort-multipart-upload --bucket "$BUCKET" --key "$key" --upload-id "$upload_id" >/dev/null 2>&1
    done
    rm -f "$tmp_multipart"

    ((retries++))
    if [ "$retries" -ge "$MAX_RETRIES" ]; then
      echo "🚨 Too many retries aborting multipart uploads. Exiting..."
      exit 1
    fi

    sleep 2  # Avoid AWS rate limiting
  done

  # **Step 4: Remove Object Lock if enabled**
  if aws s3api get-object-lock-configuration --bucket "$BUCKET" --output json >/dev/null 2>&1; then
    aws s3api delete-object-lock-configuration --bucket "$BUCKET" >/dev/null 2>&1 || true
  fi

  # **Step 5: Remove bucket policy (if exists)**
  if aws s3api get-bucket-policy --bucket "$BUCKET" --output json >/dev/null 2>&1; then
    aws s3api delete-bucket-policy --bucket "$BUCKET" >/dev/null 2>&1 || true
  fi

  # **Step 6: Ensure ACL is private**
  aws s3api put-bucket-acl --bucket "$BUCKET" --acl private >/dev/null 2>&1 || true

  # **Step 7: Retry bucket deletion**
  echo "🚀 Attempting to delete bucket: $BUCKET"
  if aws s3 rb "s3://$BUCKET" --force >/dev/null 2>&1; then
    echo "✅ Bucket $BUCKET deleted successfully."
  else
    echo "❌ Failed to delete $BUCKET (may be locked or have remaining objects)."
  fi

  echo "----------------------------------------------"
done

echo "🎉 Cleanup complete."
