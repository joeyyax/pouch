import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { brand } from "@/lib/brand";
import { getSession } from "@/lib/auth/session";
import { enabledSignInMethods } from "@/lib/auth/sign-in-methods";
import { systemMailReady } from "@/lib/mail/system";
import { devSignInEnabled } from "@/lib/dev/seed-accounts";
import { AuthScreen } from "../auth-screen";
import { listDevAccounts } from "@/lib/dev/accounts";
import { DevSignInList } from "./dev-sign-in-list";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: `Sign in — ${brand.dashboardTitle}` };

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { method } = await searchParams;
  const session = await getSession();
  if (session?.user?.id) redirect("/");

  // Development only. `signInDevAccountAction` refuses under a production NODE_ENV on its
  // own, but there's no reason to query for a list nobody in production can use.
  const devAccounts = devSignInEnabled() ? await listDevAccounts() : [];

  return (
    <AuthScreen title={`Sign in to ${brand.name}`} lede="Use the email address on your account.">
      <LoginForm enabled={await enabledSignInMethods()} mailReady={await systemMailReady()} method={typeof method === "string" ? method : undefined} />
      <DevSignInList accounts={devAccounts} />
    </AuthScreen>
  );
}
