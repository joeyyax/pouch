import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Callout } from "@/components/ui/callout";
import { TextLink } from "@/components/ui/text-link";
import { brand } from "@/lib/brand";
import { enabledSignInMethods } from "@/lib/auth/sign-in-methods";
import { AuthScreen } from "../auth-screen";
import { ResetPasswordForm } from "./reset-password-form";

export const metadata: Metadata = { title: `Choose a new password — ${brand.dashboardTitle}`, referrer: "no-referrer" };

export const dynamic = "force-dynamic";

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { token } = await searchParams;
  if (!(await enabledSignInMethods()).password) redirect("/login");

  return (
    <AuthScreen title="Choose a new password" lede="Every session on this account signs out when it changes.">
      {typeof token === "string" && token ? (
        <ResetPasswordForm token={token} />
      ) : (
        <Callout tone="danger" title="This link has no token">
          Open the link from the reset email again, or <TextLink href="/forgot-password">request a new one</TextLink>.
        </Callout>
      )}
    </AuthScreen>
  );
}
