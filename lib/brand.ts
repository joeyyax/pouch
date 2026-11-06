/**
 * Display strings only, free to change. What goes out on the wire is `lib/wire.ts`'s frozen
 * token, which deliberately doesn't read from here — see docs/decisions.md.
 */
export const brand = {
  name: "Pouch",
  fromName: "Pouch",
  /** Where system mail comes from until an operator sets one. SUPPORT_ADDRESS overrides it. */
  supportAddress: process.env.SUPPORT_ADDRESS || "support@example.org",
  dashboardTitle: "Pouch",
} as const;
