/** Which response shape each GET route returns, and why the rest take no `fields`. */
import type { ResponseShape } from "@/lib/api/shape";
import { inboundReadShape, inboundShape } from "@/lib/schemas/inbound";
import { messageListShape, messageReadShape } from "@/lib/schemas/message";
import { statsShape } from "@/lib/schemas/stats";
import {
  accountShape,
  activityShape,
  addressShape,
  adminOrganizationShape,
  adminProviderShape,
  assignmentShape,
  batchShape,
  dmarcReportShape,
  domainReadShape,
  domainShape,
  exportShape,
  forwardTargetShape,
  invitationShape,
  keyShape,
  listMemberShape,
  listShape,
  memberShape,
  organizationShape,
  providerShape,
  recipientShape,
  suppressionShape,
  webhookDeliveryReadShape,
  webhookDeliveryShape,
  webhookEndpointShape,
} from "@/lib/schemas/shapes";

export const ROUTE_SHAPES: Readonly<Record<string, ResponseShape>> = {
  "GET /v1/domains": domainShape,
  "GET /v1/domains/:id": domainReadShape,
  "GET /v1/domains/:id/dmarc_reports": dmarcReportShape,
  "GET /v1/emails": messageListShape,
  "GET /v1/emails/:id": messageReadShape,
  "GET /v1/inbound": inboundReadShape,
  "GET /v1/inbound/:id": inboundReadShape,
  "GET /v1/addresses": addressShape,
  "GET /v1/addresses/:id": addressShape,
  "GET /v1/addresses/:id/messages": inboundShape,
  "GET /v1/addresses/:id/forward_targets": forwardTargetShape,
  "GET /v1/addresses/:id/forward_targets/:targetId": forwardTargetShape,
  "GET /v1/providers": providerShape,
  "GET /v1/providers/:id": providerShape,
  "GET /v1/exports": exportShape,
  "GET /v1/exports/:id": exportShape,
  "GET /v1/suppressions": suppressionShape,
  "GET /v1/suppressions/:address": suppressionShape,
  "GET /v1/recipients/:address": recipientShape,
  "GET /v1/lists": listShape,
  "GET /v1/lists/:id": listShape,
  "GET /v1/lists/:id/members": listMemberShape,
  "GET /v1/batches/:id": batchShape,
  "GET /v1/keys": keyShape,
  "GET /v1/keys/:id": keyShape,
  "GET /v1/webhook_endpoints": webhookEndpointShape,
  "GET /v1/webhook_endpoints/:id": webhookEndpointShape,
  "GET /v1/webhook_endpoints/:id/deliveries": webhookDeliveryShape,
  "GET /v1/webhook_endpoints/:id/deliveries/:deliveryId": webhookDeliveryReadShape,
  "GET /v1/activity": activityShape,
  "GET /v1/activity/:id": activityShape,
  "GET /v1/organization": organizationShape,
  "GET /v1/admin/providers": adminProviderShape,
  "GET /v1/admin/providers/:id": adminProviderShape,
  "GET /v1/admin/providers/:id/organizations": assignmentShape,
  "GET /v1/admin/organizations": adminOrganizationShape,
  "GET /v1/admin/organizations/:id": adminOrganizationShape,
  "GET /v1/admin/organizations/:id/members": memberShape,
  "GET /v1/admin/organizations/:id/invitations": invitationShape,
  "GET /v1/admin/users": accountShape,
  "GET /v1/admin/users/:id": accountShape,
  "GET /v1/stats": statsShape,
};

/** GET routes that take neither parameter. */
export const UNSHAPED: Readonly<Record<string, string>> = {
  "GET /v1/emails/:id/events": "A stream of webhook-shaped frames, not a resource.",
  "GET /v1/events": "A stream of webhook-shaped frames, not a resource.",
  "GET /v1/lists/:id/export": "A CSV file.",
  "GET /v1/reputation": "A computed report with no id.",
  "GET /v1/domains/:id/inbound": "A domain's inbound settings, not a resource of its own.",
  "GET /v1/admin/providers/:id/convert": "A computed conversion plan.",
};

export function shapeFor(method: string, path: string): ResponseShape | undefined {
  return ROUTE_SHAPES[`${method} ${path}`];
}
