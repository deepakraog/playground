#!/usr/bin/env ts-node

/**
 * Usage:
 *   ts-node cleanS3Buckets.ts "bucket1,bucket2,bucket3"
 *
 * Requirements:
 *   - AWS SDK v3 for JavaScript
 *   - `npm install @aws-sdk/client-s3 @aws-sdk/client-cloudformation @aws-sdk/util-waiter`
 *   - Node.js 16+ or 18+ recommended
 */

import {
  S3Client,
  HeadBucketCommand,
  GetBucketTaggingCommand,
  GetBucketLocationCommand,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  DeleteBucketCommand,
  PutBucketVersioningCommand,
  ListObjectVersionsCommandOutput,
  ObjectIdentifier,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import {
  CloudFormationClient,
  DescribeStacksCommand,
  UpdateTerminationProtectionCommand,
  DeleteStackCommand,
  waitUntilStackDeleteComplete,
  DescribeStackEventsCommand,
} from "@aws-sdk/client-cloudformation";

import process from "process";

// Utility: split an array into sub-arrays of length `size`
function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// We keep one global CloudFormation client (you can modify if stacks live in multiple regions).
const cfnClient = new CloudFormationClient({ region: "us-east-1" });

// Determine the correct region for an S3 bucket
async function getBucketRegion(bucketName: string): Promise<string | null> {
  try {
    // It's okay to query location from us-east-1 for any bucket
    const globalS3Client = new S3Client({ region: "us-east-1" });
    const response = await globalS3Client.send(
      new GetBucketLocationCommand({ Bucket: bucketName })
    );
    // If empty, location is actually "us-east-1"
    return response.LocationConstraint || "us-east-1";
  } catch (error: any) {
    if (error?.Code === "NoSuchBucket") {
      // This is normal if the bucket was just deleted or doesn't exist
      console.log(
        `⚠️ Bucket ${bucketName} does not exist (NoSuchBucket). Skipping region lookup.`
      );
      return null;
    }
    console.error(
      `⚠️ Could not determine region for bucket ${bucketName}:`,
      error
    );
    return null;
  }
}

// Create an S3 client for the bucket's region
async function getS3Client(bucketName: string): Promise<S3Client | null> {
  const region = await getBucketRegion(bucketName);
  if (!region) return null;
  return new S3Client({ region });
}

// Check if a bucket exists (HEAD the bucket)
async function checkBucketExists(
  s3Client: S3Client,
  bucketName: string
): Promise<boolean> {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
    console.log(`✅ Bucket ${bucketName} exists and is accessible.`);
    return true;
  } catch (error) {
    console.error(
      `❌ Bucket ${bucketName} does not exist or is inaccessible:`,
      error
    );
    return false;
  }
}

/**
 * Optional helper: count total objects (Versions + DeleteMarkers).
 * Uncomment usage if you want to see object counts.
 */
// async function countBucketObjects(
//   s3Client: S3Client,
//   bucketName: string
// ): Promise<number> {
//   console.error(`🔍 Counting objects in bucket: ${bucketName}`);
//   let versionsCount = 0;
//   let markersCount = 0;

//   console.error("📡 Fetching object versions count...");
//   try {
//     const data = await s3Client.send(
//       new ListObjectVersionsCommand({
//         Bucket: bucketName,
//         MaxKeys: 1000,
//       })
//     );
//     versionsCount = data.Versions ? data.Versions.length : 0;
//     console.error(`📊 Versions Count (first page): ${versionsCount}`);
//   } catch {
//     versionsCount = 0;
//   }

//   console.error("📡 Fetching delete markers count...");
//   try {
//     const data = await s3Client.send(
//       new ListObjectVersionsCommand({
//         Bucket: bucketName,
//         MaxKeys: 1000,
//       })
//     );
//     markersCount = data.DeleteMarkers ? data.DeleteMarkers.length : 0;
//     console.error(`📊 Delete Markers Count (first page): ${markersCount}`);
//   } catch {
//     markersCount = 0;
//   }

//   const totalObjects = versionsCount + markersCount;
//   console.error(`📈 Total Objects in Bucket (${bucketName}): ${totalObjects}`);
//   return totalObjects;
// }

/**
 * deletePageOneByOne
 *   Fallback for a batch failure: delete each object individually.
 */
async function deletePageOneByOne(
  s3Client: S3Client,
  bucketName: string,
  objects: ObjectIdentifier[]
) {
  let totalSkipped = 0;

  for (const obj of objects) {
    try {
      await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: { Objects: [obj] },
        })
      );
    } catch (err) {
      console.log(
        `❌ Skipping object due to repeated delete failure (Key=${obj.Key}, VersionId=${obj.VersionId}).`
      );
      totalSkipped++;
    }
  }

  if (totalSkipped > 0) {
    console.log(
      `⚠️ Skipped ${totalSkipped} objects in bucket ${bucketName} due to repeated errors.`
    );
  }
}

/**
 * deletePageBatch
 *   Delete in sub-batches of up to 1000 objects.
 *   If MalformedXML or another error occurs, fallback to one-by-one.
 */
async function deletePageBatch(
  s3Client: S3Client,
  bucketName: string,
  objects: ObjectIdentifier[]
) {
  if (objects.length === 0) {
    console.log("📝 No valid objects to delete in this batch.");
    return;
  }

  console.log(
    `🗑️ Deleting ${objects.length} objects from ${bucketName} (batch delete).`
  );

  const CHUNK_SIZE = 1000;
  const chunks = chunkArray(objects, CHUNK_SIZE);

  for (const chunk of chunks) {
    console.log(`   • Deleting chunk of ${chunk.length} objects...`);
    try {
      await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: {
            Objects: chunk,
          },
        })
      );
    } catch (err: any) {
      const message = String(err);
      if (/MalformedXML/i.test(message)) {
        console.log("⚠️ MalformedXML in this chunk. Deleting one-by-one...");
        await deletePageOneByOne(s3Client, bucketName, chunk);
      } else {
        console.log("⚠️ Batch deletion failed for another reason.");
        console.log(err);
        await deletePageOneByOne(s3Client, bucketName, chunk);
      }
    }
  }
}

/**
 * NEW FUNCTION: clearMultipartUploads
 *   Abort any outstanding multi-part uploads, which can also prevent Bucket deletion.
 */
async function clearMultipartUploads(
  s3Client: S3Client,
  bucketName: string
): Promise<void> {
  console.log(
    `🚀 Checking for pending multipart uploads in bucket: ${bucketName}`
  );
  let abortedCount = 0;
  let nextKeyMarker: string | undefined;
  let nextUploadIdMarker: string | undefined;

  while (true) {
    let result;
    try {
      result = await s3Client.send(
        new ListMultipartUploadsCommand({
          Bucket: bucketName,
          KeyMarker: nextKeyMarker,
          UploadIdMarker: nextUploadIdMarker,
          MaxUploads: 1000,
        })
      );
    } catch (err) {
      console.log(`⚠️ Failed to list multipart uploads in ${bucketName}:`, err);
      break;
    }
    const uploads = result.Uploads || [];
    for (const upload of uploads) {
      if (upload.Key && upload.UploadId) {
        try {
          await s3Client.send(
            new AbortMultipartUploadCommand({
              Bucket: bucketName,
              Key: upload.Key,
              UploadId: upload.UploadId,
            })
          );
          abortedCount++;
        } catch (abortErr) {
          console.log(
            `❌ Failed to abort multipart upload for Key=${upload.Key} UploadId=${upload.UploadId}`,
            abortErr
          );
        }
      }
    }
    if (result.IsTruncated) {
      nextKeyMarker = result.NextKeyMarker;
      nextUploadIdMarker = result.NextUploadIdMarker;
    } else {
      break;
    }
  }
  console.log(`🗑️ Aborted ${abortedCount} multipart uploads in ${bucketName}.`);
}

/**
 * clearBucketContents
 *   Lists + deletes versions & delete-markers in pages of up to MaxKeys=1000
 */
async function clearBucketContents(
  s3Client: S3Client,
  bucketName: string
): Promise<void> {
  console.log(`🚀 Clearing all objects from bucket: ${bucketName}`);

  let deletedObjects = 0;
  let nextKeyMarker: string | undefined;
  let nextVersionIdMarker: string | undefined;

  while (true) {
    let page: ListObjectVersionsCommandOutput;
    try {
      page = await s3Client.send(
        new ListObjectVersionsCommand({
          Bucket: bucketName,
          MaxKeys: 1000,
          KeyMarker: nextKeyMarker,
          VersionIdMarker: nextVersionIdMarker,
        })
      );
    } catch (err) {
      console.log(
        `⚠️ Failed to list objects in ${bucketName}. Possibly no permission or bucket is gone.`,
        err
      );
      break;
    }

    const versions = page.Versions || [];
    const deleteMarkers = page.DeleteMarkers || [];

    const objectsToDelete: ObjectIdentifier[] = [];

    for (const v of versions) {
      if (v.Key) {
        objectsToDelete.push({ Key: v.Key, VersionId: v.VersionId });
      }
    }
    for (const m of deleteMarkers) {
      if (m.Key) {
        objectsToDelete.push({ Key: m.Key, VersionId: m.VersionId });
      }
    }

    await deletePageBatch(s3Client, bucketName, objectsToDelete);
    deletedObjects += objectsToDelete.length;

    nextKeyMarker = page.NextKeyMarker || undefined;
    nextVersionIdMarker = page.NextVersionIdMarker || undefined;

    if (!nextKeyMarker && !nextVersionIdMarker) {
      break;
    }
  }

  console.log(
    `🗑️ Attempted to delete ${deletedObjects} objects total in ${bucketName}.`
  );
  console.log(`🔎 Final count of objects in ${bucketName}: (skipped)`);

  // Disable versioning
  console.log(`🚀 Disabling versioning on bucket: ${bucketName}`);
  try {
    await s3Client.send(
      new PutBucketVersioningCommand({
        Bucket: bucketName,
        VersioningConfiguration: { Status: "Suspended" },
      })
    );
  } catch {
    // ignore
  }

  console.log(
    `✅ Bucket ${bucketName} is now (presumably) empty and versioning is disabled.`
  );

  // ADD THIS CALL LAST: also abort any pending multipart uploads:
  await clearMultipartUploads(s3Client, bucketName);
}

/**
 * deleteCloudFormationStack
 *   Disable termination protection if needed, then delete the stack.
 *   If an Export is in use, we skip further attempts.
 */
async function deleteCloudFormationStack(
  s3Client: S3Client,
  stackName: string,
  bucketName: string,
  nonDeletedStacks: string[]
) {
  console.log(`🚀 Attempting to delete CloudFormation stack: ${stackName}`);

  // Check if termination protection is enabled
  let protectionStatus = "False";
  try {
    const desc = await cfnClient.send(
      new DescribeStacksCommand({ StackName: stackName })
    );
    protectionStatus =
      desc.Stacks && desc.Stacks[0].EnableTerminationProtection
        ? "True"
        : "False";
  } catch {
    // ignore
  }
  console.log(`Termination protection status: ${protectionStatus}`);

  if (protectionStatus === "True") {
    console.log(
      `⚠️ Termination Protection is enabled for stack: ${stackName}. Disabling now...`
    );
    try {
      await cfnClient.send(
        new UpdateTerminationProtectionCommand({
          StackName: stackName,
          EnableTerminationProtection: false,
        })
      );
      console.log(
        `✅ Termination Protection disabled for stack: ${stackName}.`
      );
    } catch (err) {
      console.log(
        `❌ Failed to disable Termination Protection for stack: ${stackName}. Skipping deletion.`
      );
      nonDeletedStacks.push(stackName);
      return;
    }
  }

  // Double-check stack existence
  let stackExists = true;
  try {
    console.log(`🔍 Checking existence of CloudFormation stack: ${stackName}`);
    await cfnClient.send(new DescribeStacksCommand({ StackName: stackName }));
  } catch (e) {
    console.log("❌ Stack does not exist or is inaccessible. ", e);
    stackExists = false;
  }

  if (!stackExists) {
    console.log(
      `⚠️ CloudFormation stack ${stackName} does not exist or was already deleted.`
    );
    return;
  }

  // Try first stack deletion
  try {
    console.log(`🗑️ Deleting CloudFormation stack: ${stackName}`);
    await cfnClient.send(new DeleteStackCommand({ StackName: stackName }));
    console.log(
      `⏳ Waiting for CloudFormation stack ${stackName} to be deleted...`
    );

    // Wait up to ~5 minutes
    await waitUntilStackDeleteComplete(
      { client: cfnClient, maxWaitTime: 300 },
      { StackName: stackName }
    );
    console.log(`✅ CloudFormation stack ${stackName} deleted successfully.`);
    return;
  } catch (err) {
    console.log(
      `❌ Stack deletion failed on first attempt. Will clear bucket contents and retry...`
    );
  }

  // Clear the bucket contents first, then retry
  await clearBucketContents(s3Client, bucketName);

  console.log(`🚀 Retrying CloudFormation stack deletion: ${stackName}`);
  try {
    await cfnClient.send(new DeleteStackCommand({ StackName: stackName }));
    await waitUntilStackDeleteComplete(
      { client: cfnClient, maxWaitTime: 300 },
      { StackName: stackName }
    );
    console.log(`✅ CloudFormation stack ${stackName} deleted successfully.`);
  } catch (finalErr) {
    console.log(
      `❌ Final attempt to delete CloudFormation stack ${stackName} failed.`
    );
    // Possibly an export in use
    try {
      const events = await cfnClient.send(
        new DescribeStackEventsCommand({ StackName: stackName })
      );
      const topEventReason =
        events.StackEvents?.[0]?.ResourceStatusReason || "";
      if (
        /Cannot delete export/i.test(topEventReason) &&
        /in use by/i.test(topEventReason)
      ) {
        console.log(
          `❌ Delete canceled for ${stackName} due to an export in use by another stack.`
        );
      }
    } catch {
      // ignore
    }
    nonDeletedStacks.push(stackName);
  }
}

/**
 * deleteBucket
 *   Clears the bucket and attempts to DeleteBucket.
 *   Returns a boolean: true if deleted, false if not.
 */
async function deleteBucket(bucketName: string): Promise<boolean> {
  const s3Client = await getS3Client(bucketName);
  if (!s3Client) {
    // CHANGED THIS LINE:
    console.log(
      `✅ Bucket ${bucketName} does not exist (no region). Already cleaned up.`
    );
    // CHANGED THIS RETURN:
    return true;
  }

  // Make sure the bucket is still accessible
  const exists = await checkBucketExists(s3Client, bucketName);
  if (!exists) {
    // CHANGED THIS LINE:
    console.log(`✅ Bucket ${bucketName} is already gone. Nothing to do.`);
    // CHANGED THIS RETURN:
    return true;
  }

  // Empty the bucket
  console.log(`🚀 Emptying bucket: ${bucketName}`);
  await clearBucketContents(s3Client, bucketName);

  // Finally, try to delete
  try {
    console.log(`🚀 Attempting to delete bucket: ${bucketName}`);
    await s3Client.send(new DeleteBucketCommand({ Bucket: bucketName }));
    console.log(`✅ Successfully deleted bucket: ${bucketName}`);
    return true;
  } catch (error) {
    console.log(`❌ Failed to delete bucket ${bucketName}.`, error);
    return false;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 1) {
    console.error('Usage: ts-node cleanS3Buckets.ts "bucket1,bucket2,bucket3"');
    process.exit(1);
  }

  // Comma-separated bucket names
  const bucketsArg = argv[0];
  const bucketArray = bucketsArg.split(",").map((b) => b.trim());
  const nonDeletedBuckets: string[] = [];
  const nonDeletedStacks: string[] = [];

  for (const bucketName of bucketArray) {
    if (!bucketName) continue;

    console.log("----------------------------------------------");
    console.log(`📌 Checking bucket: ${bucketName}`);

    // 1) Try to find if there's a CF stack name from the bucket's tags, so we can delete the stack properly first.
    //    (We need region to fetch tags)
    let stackName: string | null = null;

    // Step (a): get S3 client for region
    const s3ClientForTags = await getS3Client(bucketName);
    if (!s3ClientForTags) {
      // If region is unknown or bucket doesn't exist, skip to deletion attempt
      const wasDeleted = await deleteBucket(bucketName);
      if (!wasDeleted) nonDeletedBuckets.push(bucketName);
      continue;
    }

    // Step (b): HEAD the bucket to confirm existence
    const exists = await checkBucketExists(s3ClientForTags, bucketName);
    if (!exists) {
      // Attempt a normal delete (probably won't do anything, but just in case)
      const wasDeleted = await deleteBucket(bucketName);
      if (!wasDeleted) nonDeletedBuckets.push(bucketName);
      continue;
    }

    // Step (c): Attempt to read CF stack tag
    try {
      const taggingResp = await s3ClientForTags.send(
        new GetBucketTaggingCommand({ Bucket: bucketName })
      );
      const cfTag = taggingResp.TagSet?.find(
        (t) => t.Key === "aws:cloudformation:stack-name"
      );
      if (cfTag && cfTag.Value) {
        stackName = cfTag.Value;
      }
    } catch {
      // No tags or insufficient permissions => ignore
    }

    // 2) If there's a CloudFormation stack, try deleting that stack first.
    if (stackName) {
      console.log(
        `⚠️ Bucket ${bucketName} is managed by CloudFormation stack: ${stackName}`
      );
      await deleteCloudFormationStack(
        s3ClientForTags,
        stackName,
        bucketName,
        nonDeletedStacks
      );
      // If CF stack deletion ultimately fails, we keep going to try a direct bucket deletion,
      // but usually if CF can't delete the bucket, direct deletion might fail as well.
    }

    // 3) Now do the final bucket deletion attempt.
    //    (If CF stack deletion was successful, the bucket might be gone now anyway.)
    const wasDeleted = await deleteBucket(bucketName);
    if (!wasDeleted) {
      nonDeletedBuckets.push(bucketName);
    }
  }

  // Summary
  console.log("----------------------------------------------");
  console.log("🎉 Cleanup process complete!");
  if (nonDeletedBuckets.length > 0) {
    console.log("⚠️ The following buckets could not be fully deleted:");
    nonDeletedBuckets.forEach((b) => console.log(`   - ${b}`));
  }
  if (nonDeletedStacks.length > 0) {
    console.log("⚠️ The following CloudFormation stacks could not be deleted:");
    nonDeletedStacks.forEach((s) => console.log(`   - ${s}`));
  }
}

// If invoked directly:
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
