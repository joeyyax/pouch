import { ROUTES } from "./spec";

/**
 * Every exported server action and every `app/api/dashboard/` route handler, against the route
 * that serves the same capability. The API is the default surface: each one either names a
 * documented route, or records why the dashboard is the only surface it has. `pnpm check:docs`
 * fails on one in neither, so a new one can't merge without that decision being made (#393).
 *
 * Keys are `<path to the file>#<action name or HTTP method>` (`lib/api-docs/surface-scan.ts`).
 * A route is `METHOD /path` exactly as `lib/api-docs/spec.ts` spells it.
 */
export type Surface = { route: string } | { only: "dashboard"; reason: string };

export const SURFACES: Record<string, Surface> = {
  // Operator: admin accounts. `users.admin` is the service-wide flag, set on either surface.
  "app/(app)/admin/settings/admins/actions.ts#promoteAdminAction": { route: "PATCH /v1/admin/users/:id" },
  "app/(app)/admin/settings/admins/actions.ts#demoteAdminAction": { route: "PATCH /v1/admin/users/:id" },
  "app/(app)/admin/settings/admins/actions.ts#deleteAccountAction": { route: "DELETE /v1/admin/users/:id" },

  // Operator: admin keys.
  "app/(app)/admin/settings/api-keys/actions.ts#createAdminKeyAction": {
    only: "dashboard",
    reason:
      "An admin key mints only in the dashboard so a leaked one can't make more — docs/decisions.md, \"Admin keys die with their creator's admin role\".",
  },
  "app/(app)/admin/settings/api-keys/actions.ts#revokeAdminKeyAction": {
    only: "dashboard",
    reason:
      "An admin key belongs to no organization and is managed where it's minted. A route would let a leaked admin key revoke every other one.",
  },

  // Operator: service mail.
  "app/(app)/admin/settings/system/mail/actions.ts#removeServiceSuppressionAction": {
    only: "dashboard",
    reason:
      "The service's suppression list belongs to no organization (docs/decisions.md, \"A null organization means the row belongs to the service\"), and its mail is read in Admin only. /v1/admin acts on organizations and providers.",
  },

  // Operator: service settings.
  "app/(app)/admin/settings/general/actions.ts#setSystemFromAddressAction": {
    only: "dashboard",
    reason:
      "Service settings configure the install, not a resource — the row has no organization (docs/decisions.md, \"A null organization means the row belongs to the service\"). /v1/admin acts on organizations and providers.",
  },
  "app/(app)/admin/settings/general/actions.ts#setSystemAlertsToAction": {
    only: "dashboard",
    reason: "Service settings configure the install, not a resource. Same reason as the system from address.",
  },
  "app/(app)/admin/settings/general/actions.ts#setDefaultProviderAction": {
    only: "dashboard",
    reason: "Service settings configure the install, not a resource. Same reason as the system from address.",
  },
  "app/(app)/admin/settings/general/actions.ts#setSettingAction": {
    only: "dashboard",
    reason: "Service settings configure the install, not a resource. Automation pins a value in pouch.yml or the entry's environment variable instead.",
  },
  "app/(app)/admin/settings/general/actions.ts#setDmarcReportHostAction": {
    only: "dashboard",
    reason: "Service settings configure the install, not a resource. Same reason as the system from address.",
  },
  "app/(app)/admin/settings/general/actions.ts#checkDmarcReportHostAction": {
    only: "dashboard",
    reason: "Checks a service setting's DNS, which belongs to the install. Same reason as the system from address.",
  },

  // Operator: organizations.
  "app/(app)/admin/settings/organizations/actions.ts#suspendOrganizationAction": {
    route: "POST /v1/admin/organizations/:id/suspend",
  },
  "app/(app)/admin/settings/organizations/actions.ts#releaseOrganizationAction": {
    route: "POST /v1/admin/organizations/:id/release",
  },
  "app/(app)/admin/settings/organizations/actions.ts#assignProviderAction": {
    route: "POST /v1/admin/providers/:id/organizations",
  },
  "app/(app)/admin/settings/organizations/actions.ts#setAddressLimitsAction": {
    route: "PATCH /v1/admin/organizations/:id",
  },
  "app/(app)/admin/settings/organizations/actions.ts#createOrganizationAdminAction": {
    route: "POST /v1/admin/organizations",
  },
  "app/(app)/admin/settings/organizations/actions.ts#startEmulationAction": {
    only: "dashboard",
    reason:
      "Emulation is a browser session acting as an organization the admin isn't in — a cookie, a banner and an expiry (docs/decisions.md, \"An admin emulates an organization deliberately\"). A key already names the organization it acts in, so there's nothing for a route to do.",
  },
  "app/(app)/emulation-actions.ts#stopEmulationAction": {
    only: "dashboard",
    reason: "Leaves the emulated organization. The same browser-session state startEmulationAction sets.",
  },

  // Operator: providers.
  "app/(app)/admin/settings/providers/actions.ts#createProviderAction": { route: "POST /v1/admin/providers" },
  "app/(app)/admin/settings/providers/actions.ts#rotateCredentialsAction": { route: "PATCH /v1/admin/providers/:id" },
  "app/(app)/admin/settings/providers/actions.ts#renameProviderAction": { route: "PATCH /v1/admin/providers/:id" },
  "app/(app)/admin/settings/providers/actions.ts#setWebhookKeyAction": { route: "PATCH /v1/admin/providers/:id" },
  "app/(app)/admin/settings/providers/actions.ts#deleteProviderAction": { route: "DELETE /v1/admin/providers/:id" },
  "app/(app)/admin/settings/providers/actions.ts#testProviderAction": { route: "POST /v1/admin/providers/:id/test" },
  "app/(app)/admin/settings/providers/actions.ts#runSetupAction": { route: "POST /v1/admin/providers/:id/setup" },
  "app/(app)/admin/settings/providers/actions.ts#assignOrganizationAction": {
    route: "POST /v1/admin/providers/:id/organizations",
  },
  "app/(app)/admin/settings/providers/actions.ts#unassignOrganizationAction": {
    route: "DELETE /v1/admin/providers/:id/organizations/:organizationId",
  },
  "app/(app)/admin/settings/providers/actions.ts#convertProviderAction": {
    route: "POST /v1/admin/providers/:id/convert",
  },
  "app/(app)/admin/settings/providers/actions.ts#adoptDomainAction": { route: "POST /v1/admin/domains" },

  // Domains.
  "app/(app)/domains/actions.ts#addDomainAction": { route: "POST /v1/domains" },
  "app/(app)/domains/actions.ts#verifyDomainAction": { route: "POST /v1/domains/:id/verify" },
  "app/(app)/domains/actions.ts#moveDomainAction": { route: "PATCH /v1/domains/:id" },
  "app/(app)/domains/actions.ts#cancelMoveAction": { route: "PATCH /v1/domains/:id" },
  "app/(app)/domains/actions.ts#deleteDomainAction": { route: "DELETE /v1/domains/:id" },
  "app/(app)/domains/actions.ts#setBulkAllowedAction": { route: "PATCH /v1/domains/:id" },
  "app/(app)/domains/actions.ts#sendTestEmailAction": { route: "POST /v1/emails" },
  "app/(app)/domains/actions.ts#applyDnsPlanAction": {
    only: "dashboard",
    reason:
      "Publishes to a DNS provider account connected in the dashboard. The API's answer to DNS is dns_records on the domain response, which the caller publishes itself.",
  },
  "app/(app)/domains/actions.ts#applyPendingDnsPlanAction": {
    only: "dashboard",
    reason: "Publishes a pending move's records through the connected DNS account. Same reason as applyDnsPlanAction.",
  },
  "app/(app)/domains/actions.ts#removeDnsCleanupAction": {
    only: "dashboard",
    reason: "Removes records through the connected DNS account. Same reason as applyDnsPlanAction.",
  },
  "app/(app)/domains/actions.ts#removePreviousAccountCleanupAction": {
    only: "dashboard",
    reason: "Removes a previous provider's records through the connected DNS account. Same reason as applyDnsPlanAction.",
  },
  "app/(app)/domains/actions.ts#releaseStallAction": {
    only: "dashboard",
    reason:
      "A pause clears only by a person (docs/api/conventions.md, \"Pausing a domain\"). A caller clearing the hold on its own sending is what the hold exists to stop.",
  },
  "app/(app)/domains/actions.ts#saveLayoutAction": { route: "PATCH /v1/domains/:id" },
  "app/(app)/domains/actions.ts#uploadLayoutLogoAction": {
    only: "dashboard",
    reason:
      "Hosts a PNG in the install's assets bucket for a session that has no URL to paste. An API caller sets layout.logo to an https URL it already serves; a route would make the install a public file host for any key.",
  },

  // Inbound.
  "app/(app)/inbound/actions.ts#redeliverInboundAction": {
    only: "dashboard",
    reason:
      "Replays a received message to the domain's webhook. An API caller is the receiver — it already has the message from GET /v1/inbound/:id.",
  },

  // Keys and webhook endpoints (#390).
  "app/(app)/keys/actions.ts#createKeyAction": { route: "POST /v1/keys" },
  "app/(app)/keys/actions.ts#updateKeyAction": { route: "PATCH /v1/keys/:id" },
  "app/(app)/keys/actions.ts#revokeKeyAction": { route: "DELETE /v1/keys/:id" },
  "app/(app)/keys/actions.ts#createWebhookEndpointAction": { route: "POST /v1/webhook_endpoints" },
  "app/(app)/keys/actions.ts#updateWebhookEndpointAction": { route: "PATCH /v1/webhook_endpoints/:id" },
  "app/(app)/keys/actions.ts#toggleWebhookDisabledAction": { route: "PATCH /v1/webhook_endpoints/:id" },
  "app/(app)/keys/actions.ts#deleteWebhookEndpointAction": { route: "DELETE /v1/webhook_endpoints/:id" },
  "app/(app)/keys/actions.ts#rotateWebhookSecretAction": { route: "POST /v1/webhook_endpoints/:id/rotate_secret" },
  "app/(app)/keys/actions.ts#revealWebhookSecretAction": {
    only: "dashboard",
    reason:
      "The API returns a signing secret at creation and at rotation and never again, so a stolen organization key can't read every receiver's secret — docs/decisions.md, \"An organization key manages keys, endpoints and settings\".",
  },
  "app/(app)/keys/actions.ts#sendTestWebhookEventAction": {
    only: "dashboard",
    reason: "Fires a sample payload at your own endpoint from the endpoint's screen. An API caller produces real events.",
  },
  "app/(app)/keys/actions.ts#loadDeliveryAttemptsAction": { route: "GET /v1/webhook_endpoints/:id/deliveries/:deliveryId" },

  // Messages.
  "app/(app)/messages/actions.ts#loadMessageBodyAction": { route: "GET /v1/emails/:id" },
  "app/(app)/messages/actions.ts#loadMessageWithBodyAction": { route: "GET /v1/emails/:id" },
  "app/(app)/messages/actions.ts#resendMessageAction": { route: "POST /v1/emails/:id/resend" },

  // Addresses.
  "app/(app)/addresses/actions.ts#createAddressAction": { route: "POST /v1/addresses" },
  "app/(app)/addresses/actions.ts#extendAddressAction": { route: "PATCH /v1/addresses/:id" },
  "app/(app)/addresses/actions.ts#revokeAddressAction": { route: "DELETE /v1/addresses/:id" },

  // Lists.
  "app/(app)/lists/actions.ts#createListAction": { route: "POST /v1/lists" },
  "app/(app)/lists/actions.ts#updateListAction": { route: "PATCH /v1/lists/:id" },
  "app/(app)/lists/actions.ts#deleteListAction": { route: "DELETE /v1/lists/:id" },
  "app/(app)/lists/actions.ts#addMemberAction": { route: "POST /v1/lists/:id/members" },
  "app/(app)/lists/actions.ts#updateMemberAttributesAction": { route: "PATCH /v1/lists/:id/members/:memberId" },
  "app/(app)/lists/actions.ts#removeMemberAction": { route: "DELETE /v1/lists/:id/members/:memberId" },
  "app/(app)/lists/actions.ts#unsubscribeMemberAction": { route: "POST /v1/lists/:id/unsubscribe" },

  // Organization settings and people.
  // Observations: the dashboard's reading of send metadata.
  "app/(app)/settings/actions.ts#muteObservationAction": {
    only: "dashboard",
    reason:
      "An observation is the dashboard's reading of send metadata, not a resource. The API serves the metadata itself (/v1/stats, /v1/emails), so it has no observation to mute.",
  },
  "app/(app)/settings/actions.ts#unmuteObservationAction": {
    only: "dashboard",
    reason: "Undoes a mute, which only the dashboard sets. Same reason as muting.",
  },
  "app/(app)/settings/actions.ts#setObservationOnAction": {
    only: "dashboard",
    reason: "Turns off what the overview and the digest say, which the API never says. Same reason as muting.",
  },
  "app/(app)/settings/actions.ts#setDmarcReportsEnabledAction": {
    only: "dashboard",
    reason:
      "Opts the organization out of a service an admin set up, the way observations are turned off. The API reads its effect: the rua in dns_records and the reports route.",
  },
  "app/(app)/settings/actions.ts#updateOrganizationSettingsAction": { route: "PATCH /v1/organization" },
  "app/(app)/settings/actions.ts#updateMemberRoleAction": { route: "PATCH /v1/admin/organizations/:id/members/:userId" },
  "app/(app)/settings/actions.ts#removeMemberAction": { route: "DELETE /v1/admin/organizations/:id/members/:userId" },
  "app/(app)/settings/actions.ts#deleteOrganizationAction": { route: "DELETE /v1/admin/organizations/:id" },
  "app/(app)/settings/actions.ts#inviteMemberAction": { route: "POST /v1/admin/organizations/:id/invitations" },
  "app/(app)/settings/actions.ts#revokeInvitationAction": { route: "DELETE /v1/admin/organizations/:id/invitations/:invitationId" },
  "app/(app)/settings/actions.ts#resendInvitationAction": {
    route: "POST /v1/admin/organizations/:id/invitations/:invitationId/resend",
  },
  "app/(app)/admin/settings/organizations/actions.ts#deleteOrganizationAdminAction": {
    route: "DELETE /v1/admin/organizations/:id",
  },

  // Suppressions.
  "app/(app)/suppressions/actions.ts#addSuppressionAction": { route: "POST /v1/suppressions" },
  "app/(app)/suppressions/actions.ts#removeSuppressionAction": { route: "DELETE /v1/suppressions/:address" },
  "app/(app)/suppressions/actions.ts#removeSuppressionAndLeaveAction": { route: "DELETE /v1/suppressions/:address" },

  // The acting organization, and organizations a signed-in person creates.
  "app/(app)/create-organization-action.ts#createOrganizationAction": { route: "POST /v1/admin/organizations" },
  "app/(app)/switch-organization-action.ts#switchOrganizationAction": {
    only: "dashboard",
    reason: "Sets which organization this browser session acts as. A key already names one.",
  },

  // The signed-in person's own account and sessions — not an organization capability.
  "app/(app)/user/settings/actions.ts#updateNameAction": {
    only: "dashboard",
    reason: "The signed-in person's own profile. A key has no person to be.",
  },
  "app/(app)/user/settings/actions.ts#updateTimeZoneAction": {
    only: "dashboard",
    reason: "The zone the dashboard shows dates in. The API answers in UTC.",
  },
  "app/(app)/user/settings/actions.ts#removePasskeyAction": {
    only: "dashboard",
    reason: "A dashboard credential. Putting it on the API would let a key take away the way a person signs in.",
  },
  "app/(app)/user/settings/actions.ts#revokeSessionAction": {
    only: "dashboard",
    reason: "Ends a browser session. Sessions are the dashboard's authority; the API's is the key.",
  },
  "app/(app)/user/settings/actions.ts#revokeOtherSessionsAction": {
    only: "dashboard",
    reason: "Ends every other browser session. Sessions are the dashboard's authority; the API's is the key.",
  },
  "app/(app)/user/settings/actions.ts#updateNotificationPreferenceAction": {
    only: "dashboard",
    reason: "The signed-in person's own email about organizations they own. A key has no person to be.",
  },
  "app/(app)/user/settings/actions.ts#updateDigestPreferencesAction": {
    only: "dashboard",
    reason:
      "An admin's own digest email, which spans every organization — docs/decisions.md, \"Digests are the service admin's, not an organization's\".",
  },

  // Sign-in activity and the dev sign-in list.
  "app/(auth)/login/actions.ts#recordSignInAction": {
    only: "dashboard",
    reason: "Logs a dashboard sign-in. A key doesn't sign in.",
  },
  "app/(auth)/login/actions.ts#recordSignOutAction": {
    only: "dashboard",
    reason: "Logs a dashboard sign-out. A key doesn't sign out.",
  },
  "app/(auth)/login/dev-sign-in-action.ts#signInDevAccountAction": {
    only: "dashboard",
    reason: "Signs in as a seeded dev account. Refuses outside development (lib/dev/seed-accounts.ts).",
  },

  "app/(auth)/login/link/actions.ts#signInWithLinkAction": {
    only: "dashboard",
    reason: "Redeems an emailed sign-in link for a browser session. A key doesn't sign in.",
  },

  // Redeeming an invitation.
  "app/(auth)/accept/actions.ts#acceptInvitationAction": {
    only: "dashboard",
    reason:
      "Takes an invitation token, not a key, and sets a password and a session. The same reason POST /v1/confirm and POST /v1/unsubscribe have no client method.",
  },
  "app/(auth)/accept/actions.ts#joinOrganizationAction": {
    only: "dashboard",
    reason: "Takes an invitation token and the caller's own session. A key carries no person to add.",
  },

  // Dashboard route handlers: downloads, uploads and the live stream a server action can't serve.
  "app/api/dashboard/exports/log/route.ts#GET": { route: "POST /v1/exports" },
  "app/api/dashboard/exports/bodies/route.ts#GET": { route: "POST /v1/exports" },
  "app/api/dashboard/exports/data/route.ts#GET": { route: "POST /v1/exports" },
  "app/api/dashboard/exports/[id]/route.ts#GET": { route: "GET /v1/exports/:id" },
  "app/api/dashboard/lists/[id]/export/route.ts#GET": { route: "GET /v1/lists/:id/export" },
  "app/api/dashboard/lists/[id]/import/route.ts#POST": { route: "POST /v1/lists/:id/members" },
  "app/api/dashboard/messages/route.ts#GET": { route: "GET /v1/events" },
  "app/api/dashboard/settings/export/route.ts#GET": {
    only: "dashboard",
    reason: "Service settings configure the install, not a resource. Same reason as setSettingAction.",
  },
  "app/api/dashboard/suppressions/export/route.ts#GET": { route: "GET /v1/suppressions" },
  "app/api/dashboard/suppressions/import/route.ts#POST": { route: "POST /v1/suppressions" },
};

/**
 * Fails at import the way `lib/mcp/registry.ts`'s `route()` does, so a renamed or retired route
 * can't leave a surface entry pointing at nothing.
 */
for (const [action, surface] of Object.entries(SURFACES)) {
  if (!("route" in surface)) continue;
  const known = ROUTES.some((spec) => `${spec.method} ${spec.path}` === surface.route);
  if (!known) {
    throw new Error(
      `lib/api-docs/surfaces: ${action} names "${surface.route}", which isn't in lib/api-docs/spec.ts.`,
    );
  }
}
