import * as fs from "fs";
import * as path from "path";

import * as ExcelJS from "exceljs";
import * as dotenv from "dotenv";
import { execSync } from "child_process";

dotenv.config();

const INPUT_FILE = process.env.INPUT_EXCEL || "AWS_Config_Report.xlsx";
const INPUT_DIR = path.join(__dirname, "input");
const INPUT_EXCEL = path.join(INPUT_DIR, INPUT_FILE);

const OUTPUT_FILE =
  process.env.OUTPUT_EXCEL || "Updated_AWS_Config_Report.xlsx";
const OUTPUT_DIR = path.join(__dirname, "output");
const OUTPUT_EXCEL = path.join(OUTPUT_DIR, OUTPUT_FILE);

/**
 * Executes AWS CLI commands safely and handles errors gracefully.
 */
const runAwsCommand = (command: string): string => {
  try {
    return execSync(command, {
      encoding: "utf-8",
      maxBuffer: 1024 * 1024 * 10,
    }).trim(); // Increased buffer to 10MB
  } catch (error: any) {
    const errorMessage = error.stderr ? error.stderr.toString() : error.message;
    console.warn(`[ERROR] AWS CLI command failed: ${command}`);
    console.warn(`[DETAILS] ${errorMessage}`);

    // Handle specific known errors
    if (errorMessage.includes("NoSuchBucketPolicy")) return "NoBucketPolicy";
    if (errorMessage.includes("NoSuchBucket")) return "NoBucket";
    if (errorMessage.includes("NoSuchLifecycleConfiguration"))
      return "NoLifecycle";
    if (errorMessage.includes("does not exist")) return "NoResource";

    return ""; // Return empty for unknown errors
  }
};

/**
 * Reads the Excel file and returns JSON data.
 */
const readExcelFile = async (): Promise<any[]> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(INPUT_EXCEL);
  const sheet = workbook.getWorksheet("AWS_Config_Report");

  if (!sheet) throw new Error(`Sheet not found: AWS_Config_Report`);

  // Read the data, excluding the header row
  return sheet
    .getSheetValues()
    .slice(2)
    .map((row: any) => ({
      resourceId: row[1], // Assuming resourceId is in column 1
      AccountId: row[2]?.toString(),
      AccountName: row[3]?.toString(),
      targetResourceType: row[4],
      complianceType: row[5],
      nonCompliantRules: row[6],
    }));
};

/**
 * Writes updated data to an Excel file.
 */
const writeExcelFile = async (data: any[]) => {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("AWS_Config_Report");

  // Add headers
  sheet.columns = [
    { header: "resourceId", key: "resourceId" },
    { header: "AccountId", key: "AccountId" },
    { header: "Account Name", key: "AccountName" },
    { header: "configuration.targetResourceType", key: "targetResourceType" },
    { header: "configuration.complianceType", key: "complianceType" },
    { header: "Non_Compliant_Rules", key: "nonCompliantRules" },
    { header: "Bucket Name", key: "BucketName" },
    { header: "Category", key: "Category" },
  ];

  // Add rows
  sheet.addRows(data);
  await workbook.xlsx.writeFile(OUTPUT_EXCEL);
};

/**
 * Categorizes an S3 bucket based on lifecycle policy, recent object activity, ACLs, and CloudFormation association.
 */
const categorizeBucket = async (bucketName: string): Promise<string> => {
  console.log(`[INFO] Processing bucket: ${bucketName}`);

  // 1️⃣ **Check if it's "No Longer Used" (Empty, No Policies, Lifecycle Auto-Delete)**
  const lifecyclePolicy = runAwsCommand(
    `aws s3api get-bucket-lifecycle-configuration --bucket ${bucketName} --query 'Rules' --output text`
  );

  //   const bucketPolicy = runAwsCommand(
  //     `aws s3api get-bucket-policy --bucket ${bucketName} --output text`
  //   );

  //   const bucketACL = runAwsCommand(
  //     `aws s3api get-bucket-acl --bucket ${bucketName} --output text`
  //   );

  const objectList = runAwsCommand(
    `aws s3api list-objects --bucket ${bucketName} --query 'Contents[*].{Key:Key,Size:Size}' --output text`
  );

  if (
    lifecyclePolicy.includes("Expiration") ||
    lifecyclePolicy.includes("NoLifecycle") ||
    !objectList
  ) {
    console.log(
      `[INFO] ${bucketName}: Categorized as 'No Longer Used (Cleanup)' (Auto-deletion + Empty + No ACLs)`
    );
    return "No Longer Used (Cleanup)";
  }

  // 2️⃣ **Check if it's "Unsure" (Has recent objects, unclear purpose)**
  const dateCommand = `gdate -d "90 days ago" --iso-8601`; // or 'date' on Linux
  const lastModifiedDate = runAwsCommand(dateCommand);
  const recentObjects = runAwsCommand(
    `aws s3api list-objects --bucket ${bucketName} --query 'Contents[?LastModified>=\`${lastModifiedDate}\`]' --output text`
  );

  if (recentObjects !== "None") {
    console.log(
      `[INFO] ${bucketName}: Categorized as 'Unsure (Review)' (Recent objects found)`
    );
    return "Unsure (Review)";
  } else if (recentObjects === "None") {
    console.log(
      `[INFO] ${bucketName}: Categorized as 'Manual Review Required' (No recent objects)`
    );
    return "Manual Review Required";
  }

  // 3️⃣ **Check if it's "Being Used" (Managed by CloudFormation/CDK)
  //     and whether the CF stack is stale (not updated in a long time).**

  // First see if there are CloudFormation resources for this bucket:
  const stackAssociation = runAwsCommand(
    `aws cloudformation list-stack-resources --stack-name ${bucketName} --query 'StackResourceSummaries[].LogicalResourceId' --output text`
  );

  if (stackAssociation !== "NoResource") {
    // The bucket is associated with a CF stack, so let's see when that stack was last updated.
    const lastUpdatedTimeRaw = runAwsCommand(
      `aws cloudformation describe-stacks --stack-name ${bucketName} \
       --query 'Stacks[0].LastUpdatedTime' --output text`
    );

    let lastUpdatedTime: Date | null = null;

    // If there's no 'LastUpdatedTime' (it might be 'None' or empty), fall back to CreationTime.
    if (!lastUpdatedTimeRaw || lastUpdatedTimeRaw === "None") {
      const creationTimeRaw = runAwsCommand(
        `aws cloudformation describe-stacks --stack-name ${bucketName} \
         --query 'Stacks[0].CreationTime' --output text`
      );
      if (creationTimeRaw && creationTimeRaw !== "None") {
        lastUpdatedTime = new Date(creationTimeRaw.trim());
      }
    } else {
      lastUpdatedTime = new Date(lastUpdatedTimeRaw.trim());
    }

    // Compare the stack's last updated time to a threshold (e.g., 180 days).
    if (lastUpdatedTime) {
      const now = new Date();
      const daysSinceUpdate =
        (now.getTime() - lastUpdatedTime.getTime()) / (1000 * 3600 * 24);

      const THRESHOLD_DAYS = 180;
      if (daysSinceUpdate > THRESHOLD_DAYS) {
        console.log(
          `[INFO] ${bucketName}: Categorized as 'Stale CloudFormation' (No stack updates in over ${THRESHOLD_DAYS} days)`
        );
        return "Stale CloudFormation";
      }
    }

    // Otherwise, if it's not stale:
    console.log(
      `[INFO] ${bucketName}: Categorized as 'Actively Used (Fix in Code)' (CloudFormation Stack)`
    );
    return "Actively Used (Fix in Code)";
  } else if (stackAssociation === "NoResource") {
    console.log(
      `[INFO] ${bucketName}: Categorized as 'No Longer Used (Cleanup)' (No CloudFormation association)`
    );
    return "No Longer Used (Cleanup)";
  }

  if (
    !lifecyclePolicy.includes("Expiration") &&
    !lifecyclePolicy.includes("NoLifecycle") &&
    !objectList &&
    !stackAssociation &&
    !recentObjects
  ) {
    console.log(
      `[INFO] ${bucketName}: Categorized as 'Manual Review Required' (No clear usage pattern)`
    );
    return "Manual Review Required";
  }
  return "";
};

/**
 * Processes the Excel file, categorizes S3 buckets, and updates the file.
 */
const processS3Buckets = async () => {
  console.log(`[INFO] Loading Excel file: ${INPUT_EXCEL}`);
  let data = await readExcelFile();

  // Ensure "Category" column exists
  if (!data[0]?.hasOwnProperty("Category")) {
    data.forEach((row) => (row["Category"] = ""));
  }

  // Get the AccountId from CLI arguments
  const accountId = process.argv[2];
  if (!accountId) {
    console.error("[ERROR] No AccountId provided.");
    process.exit(1);
  }

  // Filter by AccountId
  const filteredData = data.filter((row) => row.AccountId === accountId);
  if (filteredData.length === 0) {
    console.log(`[INFO] No records found for AccountId: ${accountId}`);
    return;
  }

  // Extract bucket names and categorize
  for (let row of filteredData) {
    row["BucketName"] = row["resourceId"]
      ? row["resourceId"].replace("AWS::S3::Bucket/", "")
      : "UNKNOWN";
    row["Category"] = await categorizeBucket(row["BucketName"]);
  }

  // Merge the updated category values back into the original data
  data.forEach((row) => {
    const updatedRow = filteredData.find(
      (fr) => fr.resourceId === row.resourceId
    );
    if (updatedRow) row["Category"] = updatedRow["Category"];
  });

  // Write updated Excel file
  await writeExcelFile(data);
  console.log(
    `[SUCCESS] Processing completed. Categorized data saved in ${OUTPUT_EXCEL}`
  );
};

// **Run the script**
processS3Buckets();
