
import {
  SecretsManagerClient,
  DescribeSecretCommand,
  DeleteSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  CloudFormationClient,
  DeleteStackCommand,
} from "@aws-sdk/client-cloudformation";


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


function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function scheduleDeletion(
  secretName: string,
  days: number,
  secretsClient: SecretsManagerClient,
  cfnClient: CloudFormationClient
): Promise<void> {
  try {
    // 1. Describe the secret to check tags
    console.log(
      `Describing secret "${secretName}" to check for CloudFormation tags...`
    );
    const describeResult = await secretsClient.send(
      new DescribeSecretCommand({ SecretId: secretName })
    );

    // 2. Check for "aws:cloudformation:stack-name" in tags
    const tags = describeResult.Tags || [];
    const cfnStackTag = tags.find(
      (tag) => tag.Key === "aws:cloudformation:stack-name"
    );

    if (cfnStackTag && cfnStackTag.Value) {
      const stackName = cfnStackTag.Value;
      console.log(
        `Found CloudFormation stack name: "${stackName}". Deleting stack...`
      );

      // 3. Delete the CloudFormation stack
      try {
        await cfnClient.send(
          new DeleteStackCommand({
            StackName: stackName,
          })
        );
        console.log(
          `Successfully initiated deletion of CloudFormation stack "${stackName}".`
        );
      } catch (cfnError) {
        console.error(
          `Failed to delete CloudFormation stack "${stackName}". Continuing with secret deletion. Error: `,
          cfnError
        );
      }
    } else {
      console.log(
        `No CloudFormation stack-name tag found for "${secretName}".`
      );
    }

    // 4. Schedule deletion of the secret
    console.log(
      `Scheduling deletion for secret "${secretName}" in ${days} day(s)...`
    );
    await secretsClient.send(
      new DeleteSecretCommand({
        SecretId: secretName,
        RecoveryWindowInDays: days,
        // If you'd like to force immediate deletion without recovery window:
        // ForceDeleteWithoutRecovery: true,
      })
    );
    await delay(1000); // Adding a delay to avoid throttling
    console.log(`Successfully scheduled deletion for "${secretName}".`);
  } catch (error) {
    console.error(`Failed to process secret "${secretName}":`, error);
  }
}

async function main() {
  // Extract arguments starting from index 2
  const args = process.argv.slice(2);

  // Parse and validate arguments
  const { secretNames, days } = parseArguments(args);

  // Initialize the Secrets Manager client and CloudFormation client
  const secretsClient = new SecretsManagerClient({ region: "us-east-1" });
  const cfnClient = new CloudFormationClient({ region: "us-east-1" });

  // Process each secret concurrently
  await Promise.all(
    secretNames.map((secretName) =>
      scheduleDeletion(secretName, days, secretsClient, cfnClient)
    )
  );

  console.log(
    "Done scheduling secrets for deletion (and any associated CloudFormation stacks)."
  );
}

main().catch((error) => {
  console.error("An unexpected error occurred:", error);
  process.exit(1);
});

(async () => {
  try {
    await main();
  } catch (err) {
    console.error("Failed to schedule secrets manager", err);
    process.exit(1);
  }
})();
