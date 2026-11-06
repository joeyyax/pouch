/** Status rules every surface shares. Reads settings, never credentials. */
import { isConfiguredFor } from "./adapters";
import type { ProviderSettings } from "./adapters/types";

/**
 * Whether a tenant's setup is still finishing: it's on a shared provider, domains already bind to
 * it, and its event plumbing isn't done.
 */
export function assignmentSettingUp(
  assignment: { sharedProviderId: string | null; adapter: string; settings: ProviderSettings },
  domainCount: number,
): boolean {
  if (assignment.sharedProviderId === null || domainCount === 0) return false;
  return !isConfiguredFor(assignment.adapter, assignment.settings);
}
