import type { Metadata } from "next";
import { Callout } from "@/components/ui/callout";
import { TextLink } from "@/components/ui/text-link";
import { brand } from "@/lib/brand";
import { getSession } from "@/lib/auth/session";
import { enabledSignInMethods } from "@/lib/auth/sign-in-methods";
import { systemMailReady } from "@/lib/mail/system";
import { normalizeInvitedAddress, previewInvitation } from "@/lib/invitations";
import { AuthScreen } from "../auth-screen";
import { AcceptForm, type AcceptMethods } from "./accept-form";
import { JoinButton } from "./join-button";

export const metadata: Metadata = { title: `Accept an invitation — ${brand.dashboardTitle}`, referrer: "no-referrer" };

export const dynamic = "force-dynamic";

/** The lede for a new account: what it sets, or how it signs in without a password. */
function newAccountLede(email: string, methods: AcceptMethods): string {
  if (methods.password) return `Set a password for ${email}.`;
  const ways = [methods.passkey ? "a passkey" : null, methods.link ? "a link emailed to you" : null].filter(Boolean).join(" or ");
  return `${email} signs in with ${ways || "a passkey"}. No password to set.`;
}

/** "an owner", "a member". */
function article(role: string): string {
  return `${role.startsWith("o") ? "an" : "a"} ${role}`;
}

export default async function AcceptInvitationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await searchParams;
  if (typeof token !== "string" || !token) {
    return (
      <AuthScreen title="Accept an invitation">
        <Callout tone="danger" title="This link has no token">
          Open the link from the invitation email again, or ask an owner to resend it.
        </Callout>
      </AuthScreen>
    );
  }

  const invitation = await previewInvitation(token);

  if (invitation.state === "unknown") {
    return (
      <AuthScreen title="Accept an invitation">
        <Callout tone="danger" title="This invitation isn't valid">
          It was revoked, or the link is incomplete. Ask an owner to send a new one.
        </Callout>
      </AuthScreen>
    );
  }

  if (invitation.state === "accepted") {
    return (
      <AuthScreen title="Accept an invitation">
        <Callout tone="warn" title="This invitation was already accepted">
          <TextLink href="/login">Sign in</TextLink> with the address it was sent to.
        </Callout>
      </AuthScreen>
    );
  }

  if (invitation.state === "expired") {
    return (
      <AuthScreen title="Accept an invitation">
        <Callout tone="warn" title="This invitation has expired">
          An invitation lasts 7 days. Ask an owner to resend it from Settings → Members.
        </Callout>
      </AuthScreen>
    );
  }

  const session = await getSession();
  const signedInAs = session?.user?.email ? normalizeInvitedAddress(session.user.email) : null;

  if (signedInAs && signedInAs !== invitation.email) {
    return (
      <AuthScreen
        title={`Join ${invitation.organizationName}`}
        lede={`This invitation is for ${invitation.email}. You're signed in as ${signedInAs}.`}
      >
        <Callout tone="warn" title="Wrong account">
          Sign out, then open the link again.
        </Callout>
        <TextLink href="/user/settings">Your account</TextLink>
      </AuthScreen>
    );
  }

  if (signedInAs) {
    return (
      <AuthScreen
        title={`Join ${invitation.organizationName}`}
        lede={`You're signed in as ${signedInAs}. Joining adds this organization to your account as ${article(invitation.role)}.`}
      >
        <JoinButton token={token} organizationName={invitation.organizationName} />
      </AuthScreen>
    );
  }

  if (!invitation.needsAccount) {
    return (
      <AuthScreen title={`Join ${invitation.organizationName}`} lede={`${invitation.email} already has a ${brand.name} account.`}>
        <Callout tone="info" title="Sign in to accept">
          <TextLink href="/login">Sign in</TextLink> as {invitation.email}, then open the link in the invitation email again.
        </Callout>
      </AuthScreen>
    );
  }

  const [enabled, mailReady] = await Promise.all([enabledSignInMethods(), systemMailReady()]);
  const methods: AcceptMethods = { password: enabled.password, passkey: enabled.passkey, link: enabled.magic_link && mailReady };

  return (
    <AuthScreen
      title={`Join ${invitation.organizationName}`}
      lede={`${newAccountLede(invitation.email, methods)} You join as ${article(invitation.role)}.`}
    >
      <AcceptForm token={token} methods={methods} />
    </AuthScreen>
  );
}
