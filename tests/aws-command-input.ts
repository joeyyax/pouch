/**
 * The command-input fields the AWS fakes read. The SDK is stubbed, so the fake is handed a bare
 * object: this declares the subset it reads rather than indexing an open record at each use.
 */
export interface AwsCommandInput {
  TenantName: string;
  ConfigurationSetName: string;
  EmailIdentity: string;
  EmailAddress: string;
  Reason: string;
  ResourceArn: string;
  Name: string;
  PolicySourceArn: string;
  ActionNames: string[];
  Tags?: { Key: string; Value: string }[];
  Content?: { Raw: { Data: Buffer } };
  SuppressionAttributes?: unknown;
  NextToken?: string;
}
