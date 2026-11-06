/** The overview's setup checklist: each step read from what the organization has, never stored. */
import type { DomainStatus } from "@/lib/db/schema/domains";

export interface SetupDomain {
  id: string;
  name: string;
  status: DomainStatus;
}

export interface SetupState {
  assigned: boolean;
  domainCount: number;
  /** The oldest domain that isn't verified. */
  unverified: SetupDomain | null;
  /** The oldest verified domain. */
  verified: SetupDomain | null;
  keyCount: number;
  liveKeyCount: number;
  /** The first send so far: live, only test mode, or none. */
  sent: "live" | "test" | null;
}

export type SetupStepKey = "domain" | "verify" | "key" | "send";

export interface SetupStep {
  key: SetupStepKey;
  title: string;
  done: boolean;
  detail: string;
  /** Where the step is done. Null when an earlier step has to land first. */
  href: string | null;
  action: string | null;
  /** Shows the send example. */
  example?: boolean;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function setupSteps(state: SetupState): SetupStep[] {
  const { unverified, verified } = state;
  const firstDomain = verified ?? unverified;

  const domain: SetupStep = {
    key: "domain",
    title: "Add a domain",
    done: state.domainCount > 0,
    detail:
      state.domainCount > 0
        ? state.domainCount === 1 && firstDomain
          ? `${firstDomain.name} added.`
          : `${plural(state.domainCount, "domain", "domains")} added.`
        : state.assigned
          ? "Mail sends from a domain you own. Adding one lists the DNS records it needs."
          : "Waits on a provider.",
    href: state.domainCount === 0 && state.assigned ? "/domains?state=add" : null,
    action: state.domainCount === 0 && state.assigned ? "Add a domain" : null,
  };

  const verify: SetupStep = {
    key: "verify",
    title: "Verify it",
    done: verified !== null,
    detail: verified
      ? `${verified.name} verified.`
      : unverified
        ? unverified.status === "failed"
          ? `${unverified.name} failed verification. Check its DNS records and verify again.`
          : `Publish the DNS records for ${unverified.name}. It verifies once they resolve.`
        : "Follows adding a domain.",
    href: !verified && unverified ? `/domains/${unverified.id}/setup` : null,
    action: !verified && unverified ? "See DNS records" : null,
  };

  const key: SetupStep = {
    key: "key",
    title: "Create a key",
    done: state.keyCount > 0,
    detail:
      state.keyCount > 0
        ? `${plural(state.keyCount, "key", "keys")} active.`
        : "Your app sends with a key. It's shown once, so copy it somewhere safe.",
    href: state.keyCount > 0 ? null : "/keys?state=create",
    action: state.keyCount > 0 ? null : "Create a key",
  };

  const testOnly = state.sent === "test";
  const needsLiveKey = testOnly && state.liveKeyCount === 0;
  const send: SetupStep = {
    key: "send",
    title: "Send a message",
    done: state.sent === "live",
    detail: testOnly
      ? "Sent in test mode. Send one with a live key."
      : verified
        ? `Send from your app with a key, or a test from ${verified.name}.`
        : "Needs a verified domain.",
    href: state.sent === "live" ? null : needsLiveKey ? "/keys?state=create" : verified ? `/domains/${verified.id}/sending` : null,
    action: state.sent === "live" ? null : needsLiveKey ? "Create a live key" : verified ? "Send a test" : null,
    example: state.sent !== "live" && !needsLiveKey && verified !== null,
  };

  return [domain, verify, key, send];
}
