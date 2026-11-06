import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains } from "@/lib/db/schema";
import type { PageBrand } from "@/lib/hosted-page";
import { brandNameFor } from "./layout";

/** How a domain's subscriber pages look: its layout's name, accent and footer, or its bare name without one. */
export async function domainPageBrand(domainId: string): Promise<PageBrand | null> {
  const [row] = await db.select({ name: domains.name, layout: domains.layout }).from(domains).where(eq(domains.id, domainId)).limit(1);
  if (!row) return null;
  if (!row.layout) return { kind: "domain", name: row.name, accent: null, footer: null };
  return { kind: "domain", name: brandNameFor(row.layout, row.name), accent: row.layout.accent, footer: row.layout.footer?.trim() || null };
}
