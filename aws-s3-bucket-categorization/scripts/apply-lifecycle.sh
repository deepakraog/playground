#!/usr/bin/env bash

set -euo pipefail

if [ $# -ne 1 ] || [ -z "$1" ]; then
  echo "Usage: $0 \"bucket1,bucket2,bucket3\""
  exit 1
fi

buckets="$1"
failed_deletions=()  # Track buckets that could not be deleted
existing_buckets=()  # Track only existing buckets

# Ensure AWS CLI is installed
if ! command -v aws &>/dev/null; then
  echo "❌ AWS CLI is not installed. Exiting..."
  exit 1
fi

# Split comma-separated bucket names into an array
IFS=',' read -ra bucket_array <<< "$buckets"
IFS=' '  # Reset IFS

# Ensure array is not empty
if [ ${#bucket_array[@]} -eq 0 ]; then
  echo "❌ No valid buckets provided. Exiting..."
  exit 1
fi

# Loop through each bucket
for BUCKET in "${bucket_array[@]}"; do
  BUCKET="$(echo "$BUCKET" | xargs)"  # Trim whitespace
  [ -z "$BUCKET" ] && continue  # Skip empty values

  echo "📌 Checking bucket existence: $BUCKET"

  # Ensure bucket exists before processing
  if ! aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
    echo "❌ Bucket $BUCKET does not exist or is inaccessible. Skipping..."
    continue  # Skip non-existing buckets
  fi

  existing_buckets+=("$BUCKET")  # Only add existing buckets

  # Try to delete the bucket first
  echo "🚀 Attempting to delete bucket: $BUCKET"
  if aws s3 rb "s3://$BUCKET" --force >/dev/null 2>&1; then
    echo "✅ Bucket $BUCKET deleted successfully."
    continue  # Skip applying lifecycle policy since bucket is deleted
  else
    echo "⚠️ Bucket $BUCKET could not be deleted. Applying lifecycle policy..."
  fi

  # Create a temporary lifecycle policy JSON file
  tmp_policy_file="$(mktemp)"
  cat > "$tmp_policy_file" <<EOL
{
  "Rules": [
    {
      "ID": "DeleteObjectsAfter1Day",
      "Prefix": "",
      "Status": "Enabled",
      "Filter": {
        "And": {
          "Prefix": "",
          "Tags": []
        }
      },
      "Expiration": {
        "Days": 1
      },
      "NoncurrentVersionExpiration": {
        "NoncurrentDays": 1,
        "NewerNoncurrentVersions": 0
      },
      "AbortIncompleteMultipartUpload": {
        "DaysAfterInitiation": 1
      }
    }
  ]
}
EOL

  echo "🚀 Applying lifecycle policy to bucket: $BUCKET"

  # Apply the lifecycle policy
  if aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration file://"$tmp_policy_file" >/dev/null 2>&1; then
    echo "✅ Lifecycle policy applied successfully to $BUCKET"
  else
    echo "❌ Failed to apply lifecycle policy to $BUCKET"
    failed_deletions+=("$BUCKET")  # Track only existing buckets that couldn't be deleted
  fi

  # Clean up temporary lifecycle policy file
  rm -f "$tmp_policy_file"

  echo "----------------------------------------------"
done

# Print a final report of all non-deleted existing buckets
if [ ${#failed_deletions[@]} -gt 0 ]; then
  echo "🚨 The following buckets exist but were NOT deleted due to errors:"
  for bucket in "${failed_deletions[@]}"; do
    echo "❌ $bucket"
  done
else
  echo "✅ All existing buckets were successfully deleted."
fi

echo "🎉 Cleanup process complete!"
