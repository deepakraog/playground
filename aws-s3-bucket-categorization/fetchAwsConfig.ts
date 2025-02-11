import * as ExcelJS from "exceljs";
import * as dotenv from "dotenv";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

const OUTPUT_DIR = path.join(__dirname, "output");
const OUTPUT_EXCEL = path.join(OUTPUT_DIR, "AWS_Config_Report.xlsx");
const AGGREGATOR_NAME =
  process.env.AGGREGATOR_NAME ||
  "aws-controltower-ConfigAggregatorForOrganizations";

// ---------------- NEW: function to read "AWS_Accounts.xlsx" ---------------
/**
 * Reads AWS_Accounts.xlsx and returns a Map of accountId -> accountName.
 */
async function readAccountMapFromExcel(
  filePath: string
): Promise<Map<string, string>> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  // If your sheet is the first tab, you can use getWorksheet(1).
  // Otherwise, adjust accordingly.
  // const sheet = workbook.getWorksheet(1);

  const sheet = workbook.getWorksheet("Organization_accounts");
  const accountMap = new Map<string, string>();

  // Assuming your header row is the first row, skip it
  sheet?.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // skip headers

    // Adjust these indices to match the columns:
    // Column A: Account ID (index=1)
    // Column D: Name (index=4)
    const rawValue = row.getCell(1).value; // This reads `87394102366`.
    const numericValue = parseInt(rawValue?.toString() || "", 10);
    // numericValue is 87394102366

    // Force it to be 12 digits with a leading zero if needed:
    const accountIdValue = numericValue.toString().padStart(12, "0");
    const accountNameCell = row.getCell(4).value;

    if (accountIdValue && accountNameCell) {
      const accountId = accountIdValue.toString();
      const accountName = accountNameCell.toString().trim();
      accountMap.set(accountIdValue, accountName);
    }
  });
  return accountMap;
}

// -------------------------------------------------------------------------
/**
 * Executes AWS CLI command and ensures the output is parsed correctly.
 */
const runAwsCommand = (command: string): any[] => {
  try {
    const result = execSync(command, {
      encoding: "utf-8",
      maxBuffer: 1024 * 1024 * 10,
    }).trim(); // Increased buffer to 10MB;
    const parsedResult = JSON.parse(result);

    if (!parsedResult.Results || !Array.isArray(parsedResult.Results)) {
      console.warn(
        `[WARN] AWS CLI output does not contain expected "Results". Returning empty array.`
      );
      return [];
    }

    // Each entry in `Results` is a JSON string, parse it into an object
    return parsedResult.Results.map((entry: string) => JSON.parse(entry));
  } catch (error: any) {
    console.error(`[ERROR] AWS CLI command failed: ${command}`);
    console.error(
      `[DETAILS] ${error.stderr ? error.stderr.toString() : error.message}`
    );
    return []; // Return an empty array to prevent errors
  }
};

/**
 * Fetches non-compliant S3 bucket details from AWS Config.
 */
const fetchAwsConfigDetails = async (): Promise<any[]> => {
  console.log(
    "[INFO] Fetching non-compliant S3 bucket details from AWS Config..."
  );

  const query = `
    SELECT
      resourceId,
      accountId,
      configuration.targetResourceType,
      configuration.complianceType,
      configuration.configRuleList
    WHERE
      resourceType = 'AWS::Config::ResourceCompliance'
      AND configuration.complianceType = 'NON_COMPLIANT'
      AND configuration.targetResourceType = 'AWS::S3::Bucket'
    `;

  const command = `aws configservice select-aggregate-resource-config --configuration-aggregator-name ${AGGREGATOR_NAME} --expression "${query}"`;

  return runAwsCommand(command);
};

/**
 * Extracts NON_COMPLIANT rules from `configRuleList` and formats them as new-line-separated strings.
 */
const extractNonCompliantRules = (configRuleList: any[]): string => {
  if (!Array.isArray(configRuleList)) {
    return "N/A";
  }

  // Filter out only the NON_COMPLIANT rules
  const nonCompliantRules = configRuleList
    .filter((rule) => rule.complianceType === "NON_COMPLIANT")
    .map((rule) => rule.configRuleName);

  return nonCompliantRules.length > 0 ? nonCompliantRules.join("\n") : "N/A";
};

/**
 * Formats AWS Config data for writing to Excel.
 *
 * @param rawData - The array of raw AWS Config items
 * @param accountMap - A Map of accountId -> accountName
 */
const formatDataForExcel = (
  rawData: any[],
  accountMap: Map<string, string>
): any[] => {
  if (!Array.isArray(rawData)) {
    console.warn(
      "[WARN] formatDataForExcel received non-array data. Returning empty array."
    );
    return [];
  }

  return rawData.map((entry) => {
    const accountId = entry.accountId.toString() || "N/A";
    // Use the map to find the matching account name
    const accountName = accountMap.get(accountId) || "N/A";

    return {
      resourceId: entry.resourceId || "N/A",
      AccountId: accountId,
      AccountName: accountName,
      targetResourceType: entry.configuration?.targetResourceType || "N/A",
      complianceType: entry.configuration?.complianceType || "N/A",
      Non_Compliant_Rules: extractNonCompliantRules(
        entry.configuration?.configRuleList
      ),
    };
  });
};

/**
 * Writes formatted data to an Excel file using `exceljs`.
 */
const writeToExcel = async (data: any[]) => {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("AWS_Config_Report");

  sheet.columns = [
    { header: "resourceId", key: "resourceId", width: 50 },
    { header: "AccountId", key: "AccountId", width: 20 },
    { header: "Account Name", key: "AccountName", width: 30 },
    { header: "Target Resource Type", key: "targetResourceType", width: 30 },
    { header: "Compliance Type", key: "complianceType", width: 20 },
    { header: "Non_Compliant_Rules", key: "Non_Compliant_Rules", width: 80 },
  ];

  data.forEach((row) => sheet.addRow(row));

  await workbook.xlsx.writeFile(OUTPUT_EXCEL);
  console.log(`[SUCCESS] AWS Config report saved in ${OUTPUT_EXCEL}`);
};

/**
 * Main function to fetch AWS Config details and save them to Excel.
 */
const generateAwsConfigReport = async () => {
  // 1. Load the accountId -> accountName map from the Excel file
  const accountMap = await readAccountMapFromExcel(
    path.join(__dirname, "input", "AWS_Accounts_(2025_01_29).xlsx")
  );

  // 2. Fetch your non-compliant data from AWS
  const rawData = await fetchAwsConfigDetails();

  if (!Array.isArray(rawData) || rawData.length === 0) {
    console.warn("[WARN] No non-compliant S3 buckets found.");
    return;
  }

  // 3. Format with the account name from the map
  const formattedData = formatDataForExcel(rawData, accountMap);

  // 4. Write to Excel
  await writeToExcel(formattedData);
};

// Run the script
generateAwsConfigReport();
