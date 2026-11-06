import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

export interface AdminSummary {
  id: string;
  name: string;
  email: string;
}

/** Every user with service-wide access, independent of any organization. */
export async function listServiceAdmins(): Promise<AdminSummary[]> {
  return db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.admin, true))
    .orderBy(asc(users.name));
}

export class UnknownEmailError extends Error {
  constructor(email: string) {
    super(`No account exists for ${email}.`);
    this.name = "UnknownEmailError";
  }
}

/** Looks a user up by email so admin access can be granted without knowing their id. */
export async function findUserByEmail(email: string): Promise<AdminSummary | null> {
  const [row] = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  return row ?? null;
}
