/**
 * Screen-local copy for the activity screen — kept out of lib/activity so the pure adapter stays
 * free of JSX and dashboard-specific wording. Consequence first, per docs/product/voice.md:
 * a filter says what happens next, not just what the thing is called.
 */
import type { ActivityFamily } from "@/lib/activity/types";
import { brand } from "@/lib/brand";

export const FAMILY_HELP: Record<ActivityFamily, string> = {
  key: "Keys authenticate the API. A revoked key stops working immediately.",
  domain: "A domain can only send once verified.",
  suppression: "A suppressed address fails at the API until removed.",
  settings: "Retention controls how long message bodies stay readable.",
  webhook: "Webhook endpoints deliver delivery events to your systems.",
  provider: `Providers hold the credentials ${brand.name} sends through.`,
  session: "Dashboard sign-in activity.",
  system: `Actions ${brand.name} takes on its own, like the retention sweep.`,
  list: "Lists and unsubscribes for bulk mode.",
};

export const ACTOR_FILTER_HELP =
  "Who made the change: a signed-in person, an API key, the worker or a provider callback.";
