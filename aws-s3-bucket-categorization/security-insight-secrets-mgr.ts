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
const OUTPUT_EXCEL = path.join(OUTPUT_DIR, "s3-secrets-mgr-findings.xlsx");
const securityHubClient = new SecurityHubClient({ region: "us-east-1" });

interface SecretsCFTagRow {
  accountId: string;
  accountName: string;
  region: string;
  secretsManager: string;
  tags: string;
}

interface noSecretsRows {
  accountId: string;
  accountName: string;
  severity: string;
  region: string;
  lastUpdated: string;
  secretsManager: string;
}

/** Ensure the output folder exists before writing files */
function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/** Fetch all active SecretsManager.3 (Secrets Manager) findings from Security Hub */
async function getSecretsManagerFindings(): Promise<AwsSecurityFinding[]> {
  const params: GetFindingsCommandInput = {
    Filters: {
      GeneratorId: [
        {
          Value: "security-control/SecretsManager.3",
          Comparison: StringFilterComparison.EQUALS,
        },
      ],
      AwsAccountId: [
        {
          Value: "471112734249",
          Comparison: StringFilterComparison.NOT_EQUALS,
        },
        {
          Value: "654654246528",
          Comparison: StringFilterComparison.NOT_EQUALS,
        },
      ],
      ResourceType: [
        {
          Value: "AwsSecretsManagerSecret",
          Comparison: StringFilterComparison.EQUALS,
        },
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
async function exportNoSecrets3ToExcel(): Promise<void> {
  ensureDir(OUTPUT_DIR);

  const allFindings = await getSecretsManagerFindings();

  // Prepare arrays for the two worksheets. We'll fill them in one pass:
  const noSslRows: noSecretsRows[] = []; // "Secrets Manager"
  const cfnTagRows: SecretsCFTagRow[] = []; // "Secrets CF Tags"

  for (const f of allFindings) {
    const accountId = f.AwsAccountId ?? "UNKNOWN_ACCOUNT";
    const accountName = f.AwsAccountName ?? "N/A";
    const severity = f.Severity?.Label ?? "N/A";
    const region = f.Region ?? "N/A";
    const secretsName =
      f.Resources?.[0]?.Details?.AwsSecretsManagerSecret?.Name ?? "N/A";
    const lastUpdated = f.UpdatedAt ?? "N/A";

    // 1) Row for the first sheet
    noSslRows.push({
      accountId,
      accountName,
      severity,
      region,
      secretsManager: secretsName,
      lastUpdated,
    });

    // 2) Row for the second sheet
    //    Use the local helper to get the CFN tag from the finding
    const cfnTagValue =
      secretsName === "N/A"
        ? "N/A (invalid Secrets name)"
        : getCloudFormationStackNameTag(f);

    cfnTagRows.push({
      accountId,
      accountName,
      region,
      secretsManager: secretsName,
      tags: cfnTagValue,
    });
  }

  // Create the workbook & sheets
  const workbook = new ExcelJS.Workbook();

  // Sheet 1: Basic Secrets listing
  const wsNoSsl = workbook.addWorksheet("SecretsManager.3 Findings");
  wsNoSsl.columns = [
    { header: "Account ID", key: "accountId", width: 15 },
    { header: "Account Name", key: "accountName", width: 20 },
    { header: "Severity", key: "severity", width: 10 },
    { header: "Region", key: "region", width: 10 },
    { header: "Secrets Name", key: "secretsManager", width: 65 },
    { header: "Last Updated", key: "lastUpdated", width: 28 },
  ];
  wsNoSsl.addRows(noSslRows);

  // Sheet 2: CFN tag info
  const wsCfnTags = workbook.addWorksheet("SecretsManager CF Tags");
  wsCfnTags.columns = [
    { header: "Account ID", key: "accountId", width: 20 },
    { header: "Account Name", key: "accountName", width: 20 },
    { header: "Region", key: "region", width: 10 },
    { header: "Secrets Name", key: "secretsManager", width: 65 },
    { header: "CloudformationTags", key: "tags", width: 40 },
  ];
  wsCfnTags.addRows(cfnTagRows);

  // Write the workbook
  await workbook.xlsx.writeFile(OUTPUT_EXCEL);

  console.log(`Excel file "${OUTPUT_EXCEL}" created.`);
  console.log(`  - "SecretsManager.3" sheet rows: ${noSslRows.length}`);
  console.log(`  - "secretsManager CF Tags" sheet rows: ${cfnTagRows.length}`);
}

// Example usage
(async () => {
  try {
    await exportNoSecrets3ToExcel();
  } catch (err) {
    console.error("Failed to export SecretsManager.3 to Excel:", err);
    process.exit(1);
  }
})();
