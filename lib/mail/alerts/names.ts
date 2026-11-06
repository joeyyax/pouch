import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys, organizations } from "@/lib/db/schema";

/** An organization's name for an alert's facts, or its id when the row is gone. */
export async function organizationName(id: string): Promise<string> {
  const [row] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, id)).limit(1);
  return row?.name ?? id;
}

/** A key's name for an alert's facts, or its id when the row is gone. */
export async function keyName(id: string): Promise<string> {
  const [row] = await db.select({ name: apiKeys.name }).from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
  return row?.name ?? id;
}
