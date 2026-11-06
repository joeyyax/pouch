import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { brand } from "@/lib/brand";
import { getSession } from "@/lib/auth/session";
import { listReachableOrganizations } from "@/lib/dashboard/session";
import { organizationCreationRefusal } from "@/lib/organizations";
import { AuthScreen } from "../auth-screen";
import { SignOutButton } from "../../(app)/sign-out-button";
import { StartForm } from "./start-form";

export const metadata: Metadata = { title: `Create an organization — ${brand.dashboardTitle}` };

export const dynamic = "force-dynamic";

/**
 * Where a signed-in person with no organization lands — after deleting their last one, or
 * after being removed from the only one they were in. Sign-up creates a user and their
 * organization together, so without this there'd be no way back in.
 */
export default async function StartPage() {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");

  const reachable = await listReachableOrganizations(session.user.id);
  if (reachable.length > 0) redirect("/");

  const refused = await organizationCreationRefusal(session.user.id);
  if (refused) {
    return (
      <AuthScreen title="No organization yet" lede="Domains, keys and messages all live in an organization, and you don't belong to one.">
        <div className="flex flex-col gap-4">
          <p className="type-body-sm text-muted-foreground">{refused}</p>
          <SignOutButton className="type-body-sm self-start text-primary-strong transition-colors hover:text-primary" />
        </div>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      title="Create an organization"
      lede="You don't belong to one. Domains, keys and messages all live in an organization, so this is the first step."
    >
      <StartForm />
    </AuthScreen>
  );
}
