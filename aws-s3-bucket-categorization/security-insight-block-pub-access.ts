import {
  SecurityHubClient,
  GetFindingsCommand,
  GetFindingsCommandInput,
  GetFindingsCommandOutput,
  AwsSecurityFinding,
  StringFilterComparison,
} from "@aws-sdk/client-securityhub";
import * as ExcelJS from "exceljs";
import path from "path";
import fs from "fs";

const OUTPUT_DIR = path.join(__dirname, "output");
const OUTPUT_EXCEL = path.join(OUTPUT_DIR, "s3-block-pub-access-findings.xlsx");
const securityHubClient = new SecurityHubClient({ region: "us-east-1" });

interface BucketCFTagRow {
  accountId: string;
  accountName: string;
  region: string;
  s3Bucket: string;
  tags: string;
}

interface blockPubAccessBucketRows {
  accountId: string;
  accountName: string;
  severity: string;
  region: string;
  lastUpdated: string;
  s3Bucket: string;
}

/** Ensure the output folder exists before writing files */
function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/** Fetch all active S3.8 (block pub access) findings from Security Hub */
async function getNoSslFindings(): Promise<AwsSecurityFinding[]> {
  const params: GetFindingsCommandInput = {
    Filters: {
      GeneratorId: [
        {
          Value: "security-control/S3.8",
          Comparison: StringFilterComparison.EQUALS,
        },
      ],
      ResourceType: [
        { Value: "AwsS3Bucket", Comparison: StringFilterComparison.EQUALS },
      ],
      WorkflowStatus: [
        { Value: "NEW", Comparison: StringFilterComparison.EQUALS },
        { Value: "NOTIFIED", Comparison: StringFilterComparison.EQUALS },
      ],
      RecordState: [
        { Value: "ACTIVE", Comparison: StringFilterComparison.EQUALS },
      ],
    },
    MaxResults: 100,
  };

  let findings: AwsSecurityFinding[] = [];
  let nextToken: string | undefined;

  do {
    const response: GetFindingsCommandOutput = await securityHubClient.send(
      new GetFindingsCommand({ ...params, NextToken: nextToken })
    );
    if (response.Findings) findings.push(...response.Findings);
    nextToken = response.NextToken;
  } while (nextToken);

  return findings;
}

/** If present, returns the CFN stack name from the first resource's Tags. Otherwise "N/A". */
function getCloudFormationStackNameTag(finding: AwsSecurityFinding): string {
  if (!finding.Resources?.length) return "N/A";
  const tags = finding.Resources[0].Tags;
  if (!tags) return "N/A";
  return tags["aws:cloudformation:stack-name"] ?? "N/A";
}

/** Main entry point: fetch findings, generate two worksheets, and write Excel */
async function exportNoSslBucketsToExcel(): Promise<void> {
  ensureDir(OUTPUT_DIR);

  const allFindings = await getNoSslFindings();

  // Prepare arrays for the two worksheets. We'll fill them in one pass:
  const noSslRows: blockPubAccessBucketRows[] = []; // "Block Pub Access Buckets"
  const cfnTagRows: BucketCFTagRow[] = []; // "Bucket CF Tags"

  for (const f of allFindings) {
    const accountId = f.AwsAccountId ?? "UNKNOWN_ACCOUNT";
    const accountName = f.AwsAccountName ?? "N/A";
    const severity = f.Severity?.Label ?? "N/A";
    const region = f.Region ?? "N/A";
    const s3BucketName = f.Resources?.[0]?.Details?.AwsS3Bucket?.Name ?? "N/A";
    const lastUpdated = f.UpdatedAt ?? "N/A";

    // 1) Row for the first sheet
    noSslRows.push({
      accountId,
      accountName,
      severity,
      region,
      s3Bucket: s3BucketName,
      lastUpdated,
    });

    // 2) Row for the second sheet
    //    Use the local helper to get the CFN tag from the finding
    const cfnTagValue =
      s3BucketName === "N/A"
        ? "N/A (invalid bucket name)"
        : getCloudFormationStackNameTag(f);

    cfnTagRows.push({
      accountId,
      accountName,
      region,
      s3Bucket: s3BucketName,
      tags: cfnTagValue,
    });
  }

  // Create the workbook & sheets
  const workbook = new ExcelJS.Workbook();

  // Sheet 1: Basic No-SSL listing
  const wsNoSsl = workbook.addWorksheet("S3.8 - Block-Pub-Access Buckets");
  wsNoSsl.columns = [
    { header: "Account ID", key: "accountId", width: 15 },
    { header: "Account Name", key: "accountName", width: 20 },
    { header: "Severity", key: "severity", width: 10 },
    { header: "Region", key: "region", width: 10 },
    { header: "S3 Bucket Name", key: "s3Bucket", width: 65 },
    { header: "Last Updated", key: "lastUpdated", width: 28 },
  ];
  wsNoSsl.addRows(noSslRows);

  // Sheet 2: CFN tag info
  const wsCfnTags = workbook.addWorksheet("Bucket CF Tags");
  wsCfnTags.columns = [
    { header: "Account ID", key: "accountId", width: 20 },
    { header: "Account Name", key: "accountName", width: 20 },
    { header: "Region", key: "region", width: 10 },
    { header: "S3 Bucket Name", key: "s3Bucket", width: 65 },
    { header: "CloudformationTags", key: "tags", width: 40 },
  ];
  wsCfnTags.addRows(cfnTagRows);

  // Write the workbook
  await workbook.xlsx.writeFile(OUTPUT_EXCEL);

  console.log(`Excel file "${OUTPUT_EXCEL}" created.`);
  console.log(
    `  - "Block Public Access Buckets" sheet rows: ${noSslRows.length}`
  );
  console.log(`  - "Bucket CF Tags" sheet rows: ${cfnTagRows.length}`);
}

// Example usage
(async () => {
  try {
    await exportNoSslBucketsToExcel();
  } catch (err) {
    console.error(
      "Failed to export S3 Block Public Access buckets to Excel:",
      err
    );
    process.exit(1);
  }
})();
