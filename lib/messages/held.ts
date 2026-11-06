import { and, eq, exists, inArray, isNotNull, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { domains, messages, organizations } from "@/lib/db/schema";
import { HOLDING_SOURCES } from "@/lib/suspension";

const heldDomain = alias(domains, "held_domain");
const heldOrganization = alias(organizations, "held_organization");

/** Queued and held by a domain stall or a suspension that holds the queue: the hold `messageHold` reports. */
export function heldCondition() {
  return and(
    eq(messages.status, "queued"),
    or(
      exists(
        db
          .select({ id: heldDomain.id })
          .from(heldDomain)
          .where(and(eq(heldDomain.id, messages.domainId), isNotNull(heldDomain.stalledAt))),
      ),
      exists(
        db
          .select({ id: heldOrganization.id })
          .from(heldOrganization)
          .where(
            and(
              eq(heldOrganization.id, messages.organizationId),
              isNotNull(heldOrganization.suspendedAt),
              inArray(heldOrganization.suspendSource, [...HOLDING_SOURCES]),
            ),
          ),
      ),
    ),
  )!;
}
