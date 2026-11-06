/** An organization's address limits: an admin's override where one is set, the install's default otherwise. */
import { readSettingValues } from "@/lib/settings/values";

export interface AddressLimits {
  /** Active addresses the organization may hold. */
  active: number;
  /** Messages one address may receive per UTC day. */
  daily: number;
}

/** The organization's own columns. Null follows the install's default. */
export interface AddressLimitOverrides {
  addressLimit: number | null;
  addressDailyMessageLimit: number | null;
}

export async function readAddressLimitDefaults(): Promise<AddressLimits> {
  const values = await readSettingValues();
  return { active: values.address_limit_default, daily: values.address_daily_message_limit_default };
}

export function effectiveAddressLimits(overrides: AddressLimitOverrides, defaults: AddressLimits): AddressLimits {
  return { active: overrides.addressLimit ?? defaults.active, daily: overrides.addressDailyMessageLimit ?? defaults.daily };
}
