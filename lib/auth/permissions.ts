// ---------------------------------------------------------------------------
// Org-level roles — single source of truth. Orthogonal to the `admin` flag on `users`:
// this axis decides what someone can do inside one organization, never whether they can see
// another one. See docs/decisions.md.
// ---------------------------------------------------------------------------

export const ROLES = {
  OWNER: "owner",
  MEMBER: "member",
} as const;

export type OrgRole = (typeof ROLES)[keyof typeof ROLES];

export const ORG_ROLES = [ROLES.OWNER, ROLES.MEMBER] as const;

const WRITE_ROLES: ReadonlySet<string> = new Set([ROLES.OWNER, ROLES.MEMBER]);

/** Owner alone: people management and deleting the organization. */
export function isOrgOwner(role: string): boolean {
  return role === ROLES.OWNER;
}

/**
 * Whether the role may write inside the organization. Both current roles may, so this refuses
 * only a role that isn't one of them — the set is closed, and a read-only role would land here.
 */
export function canWriteInOrganization(role: string): boolean {
  return WRITE_ROLES.has(role);
}
