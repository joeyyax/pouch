import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/session";
import { isAdmin } from "@/lib/auth/admin";
import { enabledSignInMethods } from "@/lib/auth/sign-in-methods";
import { hasPasswordCredential, listPasskeys, listSessions, timeZoneOptions } from "@/lib/dashboard/user-settings";
import { zoneOrUtc } from "@/lib/time-zone";
import { readDigestPreferences } from "@/lib/mail/digest/preferences";
import { ownsAnOrganization, readNotificationPreferences } from "@/lib/notifications/preferences";
import { UserSettingsScreen } from "./user-settings-screen";

export const dynamic = "force-dynamic";

export default async function UserSettingsPage() {
  const session = await requireSession();
  if (!session) redirect("/login");

  const [passkeys, sessions, hasPassword, operator, zoneOptions, methods, owner] = await Promise.all([
    listPasskeys(session.user.id),
    listSessions(session.user.id, session.session.token),
    hasPasswordCredential(session.user.id),
    isAdmin(session.user.id),
    timeZoneOptions(),
    enabledSignInMethods(),
    ownsAnOrganization(session.user.id),
  ]);
  const [digestPreferences, notificationPreferences] = await Promise.all([
    operator ? readDigestPreferences(session.user.id) : null,
    owner ? readNotificationPreferences(session.user.id) : null,
  ]);

  return (
    <UserSettingsScreen
      name={session.user.name}
      email={session.user.email}
      passkeys={passkeys}
      sessions={sessions}
      hasPassword={hasPassword}
      passkeysOn={methods.passkey}
      digestPreferences={digestPreferences}
      notificationPreferences={notificationPreferences}
      timeZone={zoneOrUtc((session.user as { timeZone?: string | null }).timeZone)}
      timeZoneOptions={zoneOptions}
    />
  );
}
