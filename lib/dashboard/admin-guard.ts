import { notFound, redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth/admin";

/**
 * The page-level half of the service-admin guard. `requireAdmin` throws a plain `Error` —
 * this turns "nobody signed in" into the login redirect every other dashboard route uses,
 * and "signed in but not an admin" into a 404 rather than a page that announces the
 * surface exists. The nav hides the entry too, but this is the guard that actually holds —
 * see `lib/auth/admin.ts`.
 */
export async function requireAdminPage() {
  try {
    return await requireAdmin();
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") redirect("/login");
    notFound();
  }
}
