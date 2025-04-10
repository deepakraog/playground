import {
  SecretsManagerClient,
  DescribeSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  CreateSecretCommand,
} from "@aws-sdk/client-secrets-manager";

// Helper function to sleep for a given number of milliseconds
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Helper function to call an AWS operation with retry logic for throttling
async function callWithRetry<T>(
  operation: () => Promise<T>,
  retries = 3,
  delayMs = 1000
): Promise<T> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      if (error.name === "ThrottlingException" && attempt < retries - 1) {
        console.log(
          `ThrottlingException encountered, waiting ${delayMs}ms before retrying (attempt ${
            attempt + 1
          }/${retries})...`
        );
        await sleep(delayMs);
      } else {
        throw error;
      }
    }
  }
  // This point should never be reached
  throw new Error("Operation failed after maximum retries");
}

function printUsage(): void {
  console.log(`
Usage:
  ts-node scheduleCleanSecretsManager.ts <secretNames> [days]

Where:
  <secretNames>  Comma-separated list of AWS Secrets Manager secret names or ARNs
  [days]         (Optional) Number of days before permanent deletion (default is 7)

Examples:
  ts-node scheduleCleanSecretsManager.ts "sm1,sm2,sm3" 10
  ts-node scheduleCleanSecretsManager.ts "sm1,sm2,sm3"
`);
}

interface ParsedArgs {
  secretNames: string[];
  days: number;
}

function parseArguments(args: string[]): ParsedArgs {
  const [secretNamesArg, daysArg] = args;

  if (!secretNamesArg) {
    printUsage();
    process.exit(1);
  }

  // Parse comma-separated secret names
  const secretNames = secretNamesArg.split(",").map((name) => name.trim());

  // Default to 7 days if not provided or invalid
  const days = parseInt(daysArg, 10) || 7;

  return { secretNames, days };
}

async function markSecretForDeletion(
  secretName: string,
  days: number,
  secretsClient: SecretsManagerClient
): Promise<void> {
  try {
    // 1. Describe the secret to get details (including LastAccessedDate)
    console.log(`Describing secret "${secretName}"...`);
    const describeResult = await callWithRetry(() =>
      secretsClient.send(new DescribeSecretCommand({ SecretId: secretName }))
    );

    // 2. Check if the secret has a LastAccessedDate; if missing, proceed with renaming.
    const lastAccessedDate = describeResult.LastAccessedDate;
    if (lastAccessedDate) {
      const lastAccessed = new Date(lastAccessedDate);
      const now = new Date();
      const daysSinceAccess =
        (now.getTime() - lastAccessed.getTime()) / (1000 * 3600 * 24);
      if (daysSinceAccess < 180) {
        console.log(
          `Secret "${secretName}" was last accessed ${daysSinceAccess.toFixed(
            1
          )} days ago. Skipping.`
        );
        return;
      }
    } else {
      console.log(
        `Secret "${secretName}" does not have a LastAccessedDate. Proceeding with renaming.`
      );
    }

    // 3. Check that the secret name matches the expected format
    const pattern =
      /^integrations\/[0-9a-fA-F-]+\/netsuite\/[0-9A-Za-z]+\/credentials$/;
    if (!pattern.test(secretName)) {
      console.log(
        `Secret "${secretName}" does not match the expected format. Skipping.`
      );
      return;
    }

    // 4. Determine the new secret name (simulate renaming)
    const newSecretName = `${secretName}-delete-me`;
    console.log(
      `Secret "${secretName}" qualifies for renaming. New name will be "${newSecretName}".`
    );

    // 5. Retrieve the current secret value, or default to an empty string if not available
    console.log(`Retrieving secret value for "${secretName}"...`);
    let secretString: string = "";
    try {
      const getSecretResult = await callWithRetry(() =>
        secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }))
      );
      secretString = getSecretResult.SecretString || "";
      if (!secretString) {
        console.log(
          `Secret "${secretName}" does not have a SecretString. Proceeding with empty value.`
        );
      }
    } catch (error: any) {
      if (error.name === "ResourceNotFoundException") {
        console.log(
          `Secret "${secretName}" value not found (ResourceNotFoundException). Proceeding with empty value.`
        );
        secretString = "";
      } else {
        throw error;
      }
    }

    // 6. Create a new secret with the new name and same (or empty) value
    console.log(`Creating new secret with name "${newSecretName}"...`);
    await callWithRetry(() =>
      secretsClient.send(
        new CreateSecretCommand({
          Name: newSecretName,
          SecretString: secretString,
          Description: `Renamed from ${secretName} for potential deletion after inactivity.`,
        })
      )
    );
    console.log(`Successfully created new secret "${newSecretName}".`);

    // 7. Schedule deletion of the original secret
    console.log(
      `Scheduling deletion for original secret "${secretName}" in ${days} day(s)...`
    );
    await callWithRetry(() =>
      secretsClient.send(
        new DeleteSecretCommand({
          SecretId: secretName,
          RecoveryWindowInDays: days,
        })
      )
    );
    console.log(
      `Successfully scheduled deletion for original secret "${secretName}".`
    );
  } catch (error) {
    console.error(`Failed to process secret "${secretName}":`, error);
  }
}

async function main() {
  // Extract arguments starting from index 2
  const args = process.argv.slice(2);

  // Parse and validate arguments
  const { secretNames, days } = parseArguments(args);

  // Initialize the Secrets Manager client (adjust region as needed)
  const secretsClient = new SecretsManagerClient({ region: "us-east-1" });

  // Process each secret concurrently
  await Promise.all(
    secretNames.map((secretName) =>
      markSecretForDeletion(secretName, days, secretsClient)
    )
  );

  console.log("Done processing secrets for renaming and scheduling deletion.");
}

main().catch((error) => {
  console.error("An unexpected error occurred:", error);
  process.exit(1);
});
