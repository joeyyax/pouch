import { assertFeatureEnabled, type Feature } from "@/lib/features";
import { failed, type ActionState } from "./action-state";

/** A server action for a feature's screens. While the feature is off it refuses, as the feature's API routes do. */
export function featureAction<Args extends unknown[]>(
  feature: Feature,
  action: (...args: Args) => Promise<ActionState>,
): (...args: Args) => Promise<ActionState> {
  return async (...args) => {
    try {
      await assertFeatureEnabled(feature);
    } catch (error) {
      return failed(error, `Feature "${feature}" is turned off.`);
    }
    return action(...args);
  };
}
