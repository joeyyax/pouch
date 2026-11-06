import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { TextLink } from "@/components/ui/text-link";
import { brand } from "@/lib/brand";
import { getSession } from "@/lib/auth/session";
import { enabledSignInMethods } from "@/lib/auth/sign-in-methods";
import { systemMailReady } from "@/lib/mail/system";
import { AuthScreen } from "../auth-screen";
import { ForgotPasswordForm, ResetUnavailable } from "./forgot-password-form";

export const metadata: Metadata = { title: `Reset password — ${brand.dashboardTitle}` };

export const dynamic = "force-dynamic";

export default async function ForgotPasswordPage() {
  const session = await getSession();
  if (session?.user?.id) redirect("/");
  if (!(await enabledSignInMethods()).password) redirect("/login");

  const ready = await systemMailReady();

  return (
    <AuthScreen title="Reset your password" lede={ready ? "Enter the address you sign in with. A reset link goes to it." : undefined}>
      {ready ? <ForgotPasswordForm /> : <ResetUnavailable />}
      <p className="type-body-sm text-muted-foreground">
        <TextLink href="/login">Back to sign in</TextLink>
      </p>
    </AuthScreen>
  );
}
