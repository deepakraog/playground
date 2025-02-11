#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 \"bucket1,bucket2,bucket3\""
  exit 1
fi

buckets="$1"
non_deleted_buckets=()  # Track buckets that could not be deleted
non_deleted_stacks=()   # Track CloudFormation stacks that could not be deleted

########################################
# count_bucket_objects
#   Count total (#Versions + #DeleteMarkers) in a bucket
#   Logs to stderr, returns integer on stdout
########################################
count_bucket_objects() {
  local bucket_name="$1"
  local versions_count=0
  local delete_markers_count=0
  local total_objects=0

  >&2 echo "🔍 Counting objects in bucket: $bucket_name"
  >&2 echo "📡 Fetching object versions count..."
  versions_count="$(
    aws s3api list-object-versions \
      --bucket "$bucket_name" \
      --query "length(Versions)" \
      --output json 2>/dev/null \
    || echo 0
  )"
  versions_count="$(echo "$versions_count" | jq -r 'tonumber // 0' 2>/dev/null || echo 0)"
  >&2 echo "📊 Versions Count: $versions_count"

  >&2 echo "📡 Fetching delete markers count..."
  delete_markers_count="$(
    aws s3api list-object-versions \
      --bucket "$bucket_name" \
      --query "length(DeleteMarkers)" \
      --output json 2>/dev/null \
    || echo 0
  )"
  delete_markers_count="$(echo "$delete_markers_count" | jq -r 'tonumber // 0' 2>/dev/null || echo 0)"
  >&2 echo "📊 Delete Markers Count: $delete_markers_count"

  total_objects=$((versions_count + delete_markers_count))
  >&2 echo "📈 Total Objects in Bucket ($bucket_name): $total_objects"

  echo "$total_objects"
}

########################################
# delete_page_one_by_one
#   Fallback: delete each object individually if a batch fails
#   due to MalformedXML. Skips objects that repeatedly fail.
########################################
delete_page_one_by_one() {
  local bucket_name="$1"
  local payload_file="$2"

  local total_skipped=0
  local arr_len
  arr_len="$(jq '.Objects | length' "$payload_file" 2>/dev/null || echo 0)"

  for i in $(seq 0 $((arr_len - 1))); do
    # Extract the single object {Key, VersionId} as JSON
    local single_obj
    single_obj="$(jq -c ".Objects[$i]" "$payload_file" 2>/dev/null || echo "")"
    if [[ -z "$single_obj" || "$single_obj" == "null" ]]; then
      continue
    fi

    local key
    key="$(echo "$single_obj" | jq -r '.Key')"
    local version_id
    version_id="$(echo "$single_obj" | jq -r '.VersionId')"

    # Safely build a minimal JSON payload for just this 1 object
    local tmp_single
    tmp_single="$(mktemp)"

    # Use jq to ensure valid JSON quoting, to avoid shell interpolation issues:
    jq -n --arg k "$key" --arg v "$version_id" \
       '{Objects: [{Key: $k, VersionId: $v}]}' \
       > "$tmp_single"

    # Attempt single-object delete
    if ! aws s3api delete-objects \
      --bucket "$bucket_name" \
      --delete "file://$tmp_single" >/dev/null 2>&1
    then
      echo "❌ Skipping object due to repeated delete failure (Key=$key, VersionId=$version_id)."
      total_skipped=$((total_skipped + 1))
    fi

    rm -f "$tmp_single"
  done

  if [ "$total_skipped" -gt 0 ]; then
    echo "⚠️ Skipped $total_skipped objects in bucket $bucket_name because of MalformedXML or other errors."
  fi
}

########################################
# delete_page_batch
#   Try deleting up to N objects in one go. If we get MalformedXML,
#   fallback to one-by-one deletion.
########################################
delete_page_batch() {
  local bucket_name="$1"
  local payload_file="$2"

  local batch_count
  batch_count="$(jq '[.Objects[]] | length' "$payload_file" 2>/dev/null || echo 0)"
  if [ "$batch_count" -eq 0 ]; then
    echo "📝 No valid objects to delete in this batch."
    return
  fi

  echo "🗑️ Deleting $batch_count objects from $bucket_name (batch delete)."

  # Attempt the batch delete
  set +e
  local output
  output="$(aws s3api delete-objects \
    --bucket "$bucket_name" \
    --delete "file://$payload_file" 2>&1)"
  local rc=$?
  set -e

  if [ $rc -ne 0 ]; then
    if echo "$output" | grep -qi "MalformedXML"; then
      echo "⚠️ MalformedXML encountered in batch. Falling back to one-by-one deletion..."
      delete_page_one_by_one "$bucket_name" "$payload_file"
    else
      echo "⚠️ Batch deletion failed for another reason. Output:"
      echo "$output"
      # Decide if you want to abort or keep going. We'll keep going for now.
    fi
  fi
}

########################################
# clear_bucket_contents
#   Lists + deletes objects in pages of up to 10,000. 
#   Only does a single initial count (and final count, if desired).
########################################
clear_bucket_contents() {
  local bucket_name="$1"

  # Single initial count (optional final count below)
  local initial_count
  initial_count="$(count_bucket_objects "$bucket_name")"
  echo "🚀 Clearing all objects from bucket: $bucket_name (Total objects: $initial_count)"

  local deleted_objects=0
  local next_token=""

  # We'll loop over pages until there's no next_token (or list fails).
  while true; do
    # Temp files for this "page"
    local tmp_list tmp_to_delete
    tmp_list="$(mktemp)"
    tmp_to_delete="$(mktemp)"

    # List up to 10,000 objects in this page
    if [[ -n "$next_token" && "$next_token" != "null" ]]; then
      if ! aws s3api list-object-versions \
        --bucket "$bucket_name" \
        --max-items 10000 \
        --starting-token "$next_token" \
        --output json \
        > "$tmp_list" 2>/dev/null
      then
        echo "⚠️ Failed to list objects in $bucket_name. Possibly no permission or the bucket is gone."
        rm -f "$tmp_list" "$tmp_to_delete"
        break
      fi
    else
      if ! aws s3api list-object-versions \
        --bucket "$bucket_name" \
        --max-items 10000 \
        --output json \
        > "$tmp_list" 2>/dev/null
      then
        echo "⚠️ Failed to list objects in $bucket_name. Possibly no permission or the bucket is gone."
        rm -f "$tmp_list" "$tmp_to_delete"
        break
      fi
    fi

    # Build the batch payload
    jq -c '{
      "Objects": (
        ((.Versions // []) + (.DeleteMarkers // []))
        | map(
            select(.Key != null and .Key != "")
            | {Key: .Key, VersionId: (.VersionId // "")}
          )
      )
    }' "$tmp_list" > "$tmp_to_delete"

    # Do a batch delete (with fallback for MalformedXML)
    delete_page_batch "$bucket_name" "$tmp_to_delete"

    # Update our overall "attempted to delete" count
    local just_deleted
    just_deleted="$(jq '[.Objects[]] | length' "$tmp_to_delete" 2>/dev/null || echo 0)"
    deleted_objects=$((deleted_objects + just_deleted))

    # Check for pagination
    next_token="$(jq -r '.NextToken' "$tmp_list" 2>/dev/null || echo "")"

    rm -f "$tmp_list" "$tmp_to_delete"

    # If there's no next_token, we've reached the end
    if [[ -z "$next_token" || "$next_token" == "null" ]]; then
      break
    fi
  done

  echo "🗑️ Attempted to delete $deleted_objects objects total in $bucket_name."

  # (Optional) Final count, if you want to see how many remain
  local final_count
  final_count="$(count_bucket_objects "$bucket_name")"
  echo "🔎 Final count of objects in $bucket_name: $final_count"

  # Disable versioning
  echo "🚀 Disabling versioning on bucket: $bucket_name"
  aws s3api put-bucket-versioning \
    --bucket "$bucket_name" \
    --versioning-configuration Status=Suspended \
    >/dev/null 2>&1 || true

  echo "✅ Bucket $bucket_name is now (presumably) empty and versioning is disabled."
}

########################################
# delete_cloudformation_stack
#   Disable termination protection if needed and delete the stack.
#   If the delete fails because an Export is in use by another stack,
#   skip further attempts and mark this stack as undeleted.
########################################
delete_cloudformation_stack() {
  local stack_name="$1"
  local bucket_name="$2"

  echo "🚀 Attempting to delete CloudFormation stack: $stack_name"

  local protection_status
  protection_status="$(
    aws cloudformation describe-stacks \
      --stack-name "$stack_name" \
      --query "Stacks[0].EnableTerminationProtection" \
      --output text 2>/dev/null \
      || echo "false"
  )"

  if [ "$protection_status" == "true" ]; then
    echo "⚠️ Termination Protection is enabled for stack: $stack_name. Disabling it now..."
    if ! aws cloudformation update-termination-protection \
         --stack-name "$stack_name" \
         --no-enable-termination-protection >/dev/null 2>&1
    then
      echo "❌ Failed to disable Termination Protection for stack: $stack_name. Skipping deletion."
      non_deleted_stacks+=("$stack_name")
      return 1
    fi
    echo "✅ Termination Protection disabled for stack: $stack_name."
  fi

  if aws cloudformation describe-stacks --stack-name "$stack_name" >/dev/null 2>&1; then
    aws cloudformation delete-stack --stack-name "$stack_name"
    echo "⏳ Waiting for CloudFormation stack $stack_name to be deleted..."

    if ! aws cloudformation wait stack-delete-complete --stack-name "$stack_name" >/dev/null 2>&1; then
      # We got an error waiting for deletion. Let's check if it's due to an export in use.
      local reason
      reason="$(
        aws cloudformation describe-stack-events \
          --stack-name "$stack_name" \
          --max-items 1 \
          --query "StackEvents[0].ResourceStatusReason" \
          --output text 2>/dev/null \
        || echo ""
      )"

      if echo "$reason" | grep -iq "Cannot delete export" && echo "$reason" | grep -iq "in use by"; then
        echo "❌ Delete canceled for $stack_name due to an export in use by another stack. Skipping further cleanup."
        non_deleted_stacks+=("$stack_name")
        return 1
      fi

      echo "❌ Stack deletion failed on first attempt. Proceeding with bucket cleanup..."

      clear_bucket_contents "$bucket_name"
      echo "🚀 Retrying CloudFormation stack deletion: $stack_name"
      aws cloudformation delete-stack --stack-name "$stack_name"

      if aws cloudformation wait stack-delete-complete --stack-name "$stack_name" >/dev/null 2>&1; then
        echo "✅ CloudFormation stack $stack_name deleted successfully."
      else
        echo "❌ Final attempt to delete CloudFormation stack $stack_name failed."
        non_deleted_stacks+=("$stack_name")
        return 1
      fi
    else
      echo "✅ CloudFormation stack $stack_name deleted successfully."
    fi
  else
    echo "⚠️ CloudFormation stack $stack_name does not exist or was already deleted."
  fi
}

################################################
# MAIN
################################################
IFS=',' read -ra bucket_array <<< "$buckets"
IFS=' '

for bucket_name in "${bucket_array[@]}"; do
  bucket_name="$(echo "$bucket_name" | xargs)"  # trim
  [ -z "$bucket_name" ] && continue

  echo "----------------------------------------------"
  echo "📌 Checking bucket existence: $bucket_name"

  if ! aws s3api head-bucket --bucket "$bucket_name" >/dev/null 2>&1; then
    echo "❌ Bucket $bucket_name does not exist or is inaccessible. Skipping..."
    continue
  fi

  # Check if bucket is managed by a CFN stack (via the special CFN tag)
  stack_name="$(
    aws s3api get-bucket-tagging \
      --bucket "$bucket_name" \
      --query "TagSet[?Key=='aws:cloudformation:stack-name'].Value | [0]" \
      --output text 2>/dev/null \
      || echo "None"
  )"

  if [ "$stack_name" != "None" ] && [ "$stack_name" != "null" ]; then
    echo "⚠️ Bucket $bucket_name is managed by CloudFormation stack: $stack_name."
    if ! delete_cloudformation_stack "$stack_name" "$bucket_name"; then
      non_deleted_buckets+=("$bucket_name")
      continue
    fi
  fi

  # Empty the bucket (versions + markers)
  clear_bucket_contents "$bucket_name"

  echo "🚀 Attempting to delete bucket: $bucket_name"
  if aws s3 rb "s3://$bucket_name" --force >/dev/null 2>&1; then
    echo "✅ Bucket $bucket_name deleted successfully."
  else
    echo "❌ Bucket $bucket_name could not be deleted."
    non_deleted_buckets+=("$bucket_name")
  fi
done

echo "----------------------------------------------"
echo "🎉 Cleanup process complete!"
if [ "${#non_deleted_buckets[@]}" -gt 0 ]; then
  echo "⚠️ The following buckets could not be fully deleted:"
  for b in "${non_deleted_buckets[@]}"; do
    echo "   - $b"
  done
fi

if [ "${#non_deleted_stacks[@]}" -gt 0 ]; then
  echo "⚠️ The following CloudFormation stacks could not be deleted:"
  for s in "${non_deleted_stacks[@]}"; do
    echo "   - $s"
  done
fi

exit 0
