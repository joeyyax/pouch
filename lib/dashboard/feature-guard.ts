import { notFound } from "next/navigation";
import { isFeatureEnabled, type Feature } from "@/lib/features";

/** A screen for a feature that's off reads as not found. */
export async function requireFeaturePage(feature: Feature): Promise<void> {
  if (!(await isFeatureEnabled(feature))) notFound();
}
