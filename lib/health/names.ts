/**
 * The loops the worker runs, and nothing else.
 *
 * Its own file, with no imports, because both sides of the client boundary need it: `lib/health`
 * pulls in ioredis and can't be imported from a `"use client"` component, so the dashboard's views
 * used to restate this union as a literal and the two drifted apart by construction. A
 * dependency-free adapter both can import costs less than the comment explaining the copy did.
 *
 * Adding a name here is what puts a loop on the admin system screen. `IntervalLoop` reports a
 * heartbeat under this name for every loop that extends it, so the list and the running loops
 * can't disagree unless someone hand-rolls a loop outside that base class.
 */
export const LOOP_NAMES = [
  "send",
  "verify",
  "retention",
  "test-mode",
  "webhook",
  "digest",
  "inbound-retention",
  "address-expiry",
  "forward",
  "list",
  "abandon",
  "export",
  "stall-guard",
  "provider-health",
  "blocklists",
  "domain-stats",
  "activity-retention",
  "health-watch",
] as const;

export type LoopName = (typeof LOOP_NAMES)[number];
