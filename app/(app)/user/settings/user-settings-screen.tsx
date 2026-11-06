"use client";

import { keepValues } from "../../_ui/keep-values";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, fieldClasses } from "@/components/ui/field";
import type { PasskeySummary, SessionSummary, TimeZoneOption } from "@/lib/dashboard/user-settings";
import type { DigestPreferencesView } from "@/lib/mail/digest/preferences";
import type { NotificationPreferenceView } from "@/lib/notifications/preferences";
import { PageHeader } from "../../_ui/page-header";
import { SectionHeader } from "../../_ui/section-header";
import { useAction } from "../../_ui/use-action";
import { updateNameAction } from "./actions";
import { DigestPreferencesSection } from "./digest-preferences-section";
import { NotificationPreferencesSection } from "./notification-preferences-section";
import { PasskeysSection } from "./passkeys-section";
import { SessionsSection } from "./sessions-section";
import { TimeZoneSection } from "./time-zone-section";

export function UserSettingsScreen({
  name,
  email,
  passkeys,
  sessions,
  hasPassword,
  passkeysOn,
  digestPreferences,
  notificationPreferences,
  timeZone,
  timeZoneOptions,
}: {
  name: string;
  email: string;
  passkeys: PasskeySummary[];
  sessions: SessionSummary[];
  hasPassword: boolean;
  /** Passkey sign-in is on for the install. Off, no passkey can be added. */
  passkeysOn: boolean;
  digestPreferences: DigestPreferencesView | null;
  /** Null when this person owns no organization. */
  notificationPreferences: NotificationPreferenceView[] | null;
  timeZone: string;
  timeZoneOptions: TimeZoneOption[];
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const rename = useAction(updateNameAction);

  return (
    <>
      <PageHeader
        titleRef={heading}
        title="Your settings"
        description="Apply to your account in every organization."
      />

      <div className="flex flex-col gap-6">
        <Section title="Profile">
          <Card className="p-5">
            <form
              onSubmit={keepValues(rename.formAction)}
              className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-6"
            >
              <Field
                id="name"
                label="Name"
                error={rename.state.status === "error" && rename.state.field === "name" ? rename.state.message : undefined}
                className="w-full max-w-sm"
              >
                <input
                  id="name"
                  name="name"
                  defaultValue={name}
                  required
                  maxLength={200}
                  className={`${fieldClasses({ shape: "compact", size: "md" })} w-full`}
                />
              </Field>
              <Button type="submit" size="md" loading={rename.pending} className="shrink-0">
                Save name
              </Button>
            </form>
            <p className="type-body-sm mt-4 text-muted-foreground">
              Email <span className="break-all font-mono text-foreground">{email}</span>. Sign in with this address.
            </p>
          </Card>
        </Section>

        <Section title="Dates and times">
          <TimeZoneSection key={timeZone} saved={timeZone} options={timeZoneOptions} />
        </Section>

        <Section
          title="Passkeys"
          description="Sign in without a password. Each one is tied to a device or password manager."
        >
          <PasskeysSection passkeys={passkeys} hasPassword={hasPassword} canAdd={passkeysOn} />
        </Section>

        <Section title="Sessions" description="Devices signed in to your account.">
          <SessionsSection sessions={sessions} />
        </Section>

        {notificationPreferences ? (
          <Section id="notifications" title="Notifications" description="Email about the organizations you own, in each of them.">
            <NotificationPreferencesSection preferences={notificationPreferences} />
          </Section>
        ) : null}

        {digestPreferences ? (
          <Section
            title="Digests"
            description="Emailed summaries of sending across every organization."
          >
            <DigestPreferencesSection preferences={digestPreferences} />
          </Section>
        ) : null}
      </div>
    </>
  );
}

function Section({
  id,
  title,
  description,
  children,
}: {
  id?: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="flex scroll-mt-6 flex-col gap-3">
      <SectionHeader title={title} description={description} />
      {children}
    </section>
  );
}
