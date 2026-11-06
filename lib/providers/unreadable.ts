/** A provider's stored credentials don't decrypt under this install's ENCRYPTION_KEY. No imports, so client-safe code can check for it. */
export class CredentialsUnreadableError extends Error {
  constructor(readonly providerName: string) {
    super(`Provider ${providerName}'s credentials can't be decrypted with this install's ENCRYPTION_KEY.`);
    this.name = "CredentialsUnreadableError";
  }
}
