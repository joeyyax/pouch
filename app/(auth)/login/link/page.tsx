import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { brand } from "@/lib/brand";
import { getSession } from "@/lib/auth/session";
import { enabledSignInMethods } from "@/lib/auth/sign-in-methods";
import { AuthScreen } from "../../auth-screen";
import { LinkExpired, LinkSignIn } from "./link-sign-in";

export const metadata: Metadata = { title: `Sign in — ${brand.dashboardTitle}`, referrer: "no-referrer" };

export const dynamic = "force-dynamic";

export default async function SignInLinkPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await getSession();
  if (session?.user?.id) redirect("/");
  if (!(await enabledSignInMethods()).magic_link) redirect("/login");

  const { token } = await searchParams;
  const hasToken = typeof token === "string" && token.length > 0;

  return (
    <AuthScreen title={hasToken ? `Sign in to ${brand.name}` : "Sign-in link"}>
      {hasToken ? <LinkSignIn token={token} /> : <LinkExpired missing />}
    </AuthScreen>
  );
}
