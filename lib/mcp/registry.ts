import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { ROUTES, type RouteSpec } from "@/lib/api-docs/spec";
import { adoptDomainSchema, createDomainSchema, listDomainsSchema, patchDomainSchema } from "@/lib/schemas/domain";
import { createExportSchema, listExportsSchema } from "@/lib/schemas/export";
import { sendEmailSchema } from "@/lib/schemas/email";
import { listMessagesSchema } from "@/lib/schemas/message";
import { MESSAGE_STATUSES } from "@/lib/db/schema/messages";
import { shapeToolArgs } from "@/lib/api/shape";
import { shapeFor } from "@/lib/api-docs/shapes";
import { importSuppressionsSchema, listSuppressionsSchema } from "@/lib/schemas/suppression";
import {
  addMemberSchema,
  createListSchema,
  importMembersSchema,
  listListsSchema,
  listMembersSchema,
  unsubscribeAddressSchema,
  updateListSchema,
  updateMemberSchema,
} from "@/lib/schemas/list";
import { createBatchSchema } from "@/lib/schemas/batch";
import { listInboundSchema, updateInboundSchema } from "@/lib/schemas/inbound";
import {
  ADDRESS_WAIT_MAX_SECONDS,
  addForwardTargetSchema,
  createAddressSchema,
  listAddressesSchema,
  listAddressMessagesSchema,
  replyFromAddressSchema,
  updateAddressSchema,
} from "@/lib/schemas/address";
import { listProvidersSchema } from "@/lib/schemas/provider";
import { createKeySchema, listKeysSchema, updateKeySchema } from "@/lib/schemas/key";
import {
  createWebhookEndpointSchema,
  listWebhookDeliveriesSchema,
  listWebhookEndpointsSchema,
  updateWebhookEndpointSchema,
} from "@/lib/schemas/webhook-endpoint";
import { listActivitySchema } from "@/lib/schemas/activity";
import { updateOrganizationSettingsSchema } from "@/lib/schemas/organization-settings";
import { createInvitationSchema, listInvitationsSchema } from "@/lib/schemas/invitation";
import {
  assignOrganizationSchema,
  createAdminProviderSchema,
  listProviderOrganizationsSchema,
  listAdminProvidersSchema,
  listAdminOrganizationsSchema,
  patchAdminProviderSchema,
  patchAdminOrganizationSchema,
  suspendOrganizationSchema,
  createAdminOrganizationSchema,
  listAdminUsersSchema,
  patchAdminUserSchema,
  listMembershipsSchema,
  patchMembershipSchema,
} from "@/lib/schemas/admin";

import { GET as domainsGET, POST as domainsPOST } from "@/app/api/v1/domains/route";
import { DELETE as domainDELETE, GET as domainGET, PATCH as domainPATCH } from "@/app/api/v1/domains/[id]/route";
import { POST as domainVerifyPOST } from "@/app/api/v1/domains/[id]/verify/route";
import { GET as emailsGET, POST as emailsPOST } from "@/app/api/v1/emails/route";
import { GET as emailGET } from "@/app/api/v1/emails/[id]/route";
import { GET as emailEventsGET } from "@/app/api/v1/emails/[id]/events/route";
import { POST as emailResendPOST } from "@/app/api/v1/emails/[id]/resend/route";
import { GET as providersGET } from "@/app/api/v1/providers/route";
import { GET as providerGET } from "@/app/api/v1/providers/[id]/route";
import { GET as exportsGET, POST as exportsPOST } from "@/app/api/v1/exports/route";
import { GET as exportGET } from "@/app/api/v1/exports/[id]/route";
import { GET as reputationGET } from "@/app/api/v1/reputation/route";
import { GET as statsGET } from "@/app/api/v1/stats/route";
import { statsQueryFields } from "@/lib/schemas/stats";
import { GET as suppressionsGET, POST as suppressionsPOST } from "@/app/api/v1/suppressions/route";
import { DELETE as suppressionDELETE, GET as suppressionGET } from "@/app/api/v1/suppressions/[address]/route";
import { GET as recipientGET } from "@/app/api/v1/recipients/[address]/route";
import { GET as listsGET, POST as listsPOST } from "@/app/api/v1/lists/route";
import { DELETE as listDELETE, GET as listGET, PATCH as listPATCH } from "@/app/api/v1/lists/[id]/route";
import { GET as membersGET, POST as membersPOST } from "@/app/api/v1/lists/[id]/members/route";
import { DELETE as memberDELETE, PATCH as memberPATCH } from "@/app/api/v1/lists/[id]/members/[memberId]/route";
import { GET as listExportGET } from "@/app/api/v1/lists/[id]/export/route";
import { POST as listUnsubscribePOST } from "@/app/api/v1/lists/[id]/unsubscribe/route";
import { POST as domainUnsubscribePOST } from "@/app/api/v1/domains/[id]/unsubscribe/route";
import { POST as batchesPOST } from "@/app/api/v1/batches/route";
import { GET as batchGET } from "@/app/api/v1/batches/[id]/route";
import { GET as inboundGET } from "@/app/api/v1/inbound/route";
import { GET as inboundMessageGET } from "@/app/api/v1/inbound/[id]/route";
import { GET as domainInboundGET, PATCH as domainInboundPATCH } from "@/app/api/v1/domains/[id]/inbound/route";
import { GET as domainDmarcReportsGET } from "@/app/api/v1/domains/[id]/dmarc_reports/route";
import { listDmarcReportsSchema } from "@/lib/schemas/dmarc";
import { GET as addressesGET, POST as addressesPOST } from "@/app/api/v1/addresses/route";
import { DELETE as addressDELETE, GET as addressGET, PATCH as addressPATCH } from "@/app/api/v1/addresses/[id]/route";
import { GET as addressMessagesGET } from "@/app/api/v1/addresses/[id]/messages/route";
import { POST as addressReplyPOST } from "@/app/api/v1/addresses/[id]/reply/route";
import { GET as forwardTargetsGET, POST as forwardTargetsPOST } from "@/app/api/v1/addresses/[id]/forward_targets/route";
import { DELETE as forwardTargetDELETE, GET as forwardTargetGET } from "@/app/api/v1/addresses/[id]/forward_targets/[targetId]/route";
import { POST as forwardTargetResendPOST } from "@/app/api/v1/addresses/[id]/forward_targets/[targetId]/resend_confirmation/route";
import { GET as keysGET, POST as keysPOST } from "@/app/api/v1/keys/route";
import { DELETE as keyDELETE, GET as keyGET, PATCH as keyPATCH } from "@/app/api/v1/keys/[id]/route";
import { GET as endpointsGET, POST as endpointsPOST } from "@/app/api/v1/webhook_endpoints/route";
import {
  DELETE as endpointDELETE,
  GET as endpointGET,
  PATCH as endpointPATCH,
} from "@/app/api/v1/webhook_endpoints/[id]/route";
import { POST as endpointRotatePOST } from "@/app/api/v1/webhook_endpoints/[id]/rotate_secret/route";
import { GET as endpointDeliveriesGET } from "@/app/api/v1/webhook_endpoints/[id]/deliveries/route";
import { GET as endpointDeliveryGET } from "@/app/api/v1/webhook_endpoints/[id]/deliveries/[deliveryId]/route";
import { GET as activityListGET } from "@/app/api/v1/activity/route";
import { GET as activityGET } from "@/app/api/v1/activity/[id]/route";
import { GET as organizationGET, PATCH as organizationPATCH } from "@/app/api/v1/organization/route";
import { POST as adminDomainsPOST } from "@/app/api/v1/admin/domains/route";
import { GET as adminProvidersGET, POST as adminProvidersPOST } from "@/app/api/v1/admin/providers/route";
import {
  DELETE as adminProviderDELETE,
  GET as adminProviderGET,
  PATCH as adminProviderPATCH,
} from "@/app/api/v1/admin/providers/[id]/route";
import { POST as adminProviderTestPOST } from "@/app/api/v1/admin/providers/[id]/test/route";
import { POST as adminProviderSetupPOST } from "@/app/api/v1/admin/providers/[id]/setup/route";
import { GET as adminConvertGET, POST as adminConvertPOST } from "@/app/api/v1/admin/providers/[id]/convert/route";
import {
  GET as adminAssignmentsGET,
  POST as adminAssignmentsPOST,
} from "@/app/api/v1/admin/providers/[id]/organizations/route";
import { DELETE as adminAssignmentDELETE } from "@/app/api/v1/admin/providers/[id]/organizations/[organizationId]/route";
import { GET as adminOrganizationsGET, POST as adminOrganizationsPOST } from "@/app/api/v1/admin/organizations/route";
import { GET as adminMembersGET } from "@/app/api/v1/admin/organizations/[id]/members/route";
import {
  GET as adminInvitationsGET,
  POST as adminInvitationsPOST,
} from "@/app/api/v1/admin/organizations/[id]/invitations/route";
import { DELETE as adminInvitationDELETE } from "@/app/api/v1/admin/organizations/[id]/invitations/[invitationId]/route";
import { POST as adminInvitationResendPOST } from "@/app/api/v1/admin/organizations/[id]/invitations/[invitationId]/resend/route";
import {
  DELETE as adminMemberDELETE,
  PATCH as adminMemberPATCH,
} from "@/app/api/v1/admin/organizations/[id]/members/[userId]/route";
import { GET as adminUsersGET } from "@/app/api/v1/admin/users/route";
import {
  DELETE as adminUserDELETE,
  GET as adminUserGET,
  PATCH as adminUserPATCH,
} from "@/app/api/v1/admin/users/[id]/route";
import {
  DELETE as adminOrganizationDELETE,
  GET as adminOrganizationGET,
  PATCH as adminOrganizationPATCH,
} from "@/app/api/v1/admin/organizations/[id]/route";
import { POST as adminSuspendPOST } from "@/app/api/v1/admin/organizations/[id]/suspend/route";
import { POST as adminReleasePOST } from "@/app/api/v1/admin/organizations/[id]/release/route";

/**
 * Every /v1 route handler this registry can call takes this shape once it's been through
 * withApiKey — a plain Request plus the resolved dynamic segments, nothing MCP-specific. The
 * five files behind these imports each declare their own local `Context` type of the identical
 * shape; TypeScript accepts the assignment structurally.
 */
// Each route file's own Context type differs only in which keys its params carry; `any` is
// what lets this registry hold handlers for both zero-param and single-param routes without
// ten near-identical aliases.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RouteHandler = (request: Request, context?: any) => Promise<Response>;

/**
 * One tool = one /v1 route. `route` is looked up from lib/api-docs/spec.ts — the generator #4/#61
 * built — so a tool's summary, auth requirement and error list can never say something the docs
 * page doesn't. `inputSchema` is the same zod object the route itself parses with; nothing here
 * re-describes a field or re-implements a rule the route already enforces.
 *
 * Every documented route has a tool except those tests/unit/mcp-coverage.test.ts excludes. A
 * route is never left out for being destructive. The key that authenticates a tool call is the
 * same key that would authenticate a direct HTTP call to the same route, so leaving a route out here stops nothing —
 * it only makes the tool list lie about what the key can do. What a client gets instead is
 * `annotations`, the MCP-native way to flag a call as destructive: a client can prompt or
 * confirm on `destructiveHint`, which is where that decision belongs, not in a hand-picked
 * exclusion list here.
 */
export interface McpToolDefinition {
  /** snake_case tool name, e.g. "list_domains". */
  name: string;
  route: RouteSpec;
  inputSchema: z.ZodType;
  handler: RouteHandler;
  /** Names of `:segment` path params this route takes, e.g. ["id"]. */
  pathParams: string[];
  /** Where the non-path fields of a validated call go on the constructed request. */
  payload: "body" | "query" | "none";
  /**
   * Honest hints, not enforcement — the route behind the tool is what actually gates anything.
   * `readOnlyHint`: true for every GET. `destructiveHint`: true for the DELETEs, the unsubscribes,
   * the inbound update, which rotates the webhook secret, a manual suspension and a conversion.
   * `idempotentHint`: true wherever calling twice with the same arguments leaves the same end
   * state (a GET, a PATCH that sets a value, a DELETE of an already-gone resource, a check that
   * only reads and reports). false for anything that creates a new row each time it's called.
   */
  annotations: ToolAnnotations;
  /**
   * True for the one tool whose route streams SSE (`GET /v1/emails/:id/events`) rather than
   * returning a completed Response. `lib/mcp/server.ts` dispatches these through
   * `lib/mcp/watch.ts`'s `invokeWatchTool` instead of the ordinary request/response path in
   * `lib/mcp/invoke.ts`'s `toCallToolResult` — the route itself is unchanged either way.
   */
  stream?: boolean;
  /** Listed only to admin-scope keys. The route refuses any other key regardless. */
  admin?: boolean;
}

function route(method: RouteSpec["method"], path: string): RouteSpec {
  const found = ROUTES.find((r) => r.method === method && r.path === path);
  if (!found) throw new Error(`lib/mcp/registry: no route spec for ${method} ${path} — is lib/api-docs/spec.ts out of date?`);
  return found;
}

function idField(resource: string): z.ZodType {
  return z.string().min(1).describe(`Id of the ${resource}, as returned by a create or list call.`);
}

/**
 * `since`/`until` are `z.coerce.date()` on the real schema, which is exactly right for a route
 * that reads the value once, coerced — but a native `Date` has no JSON Schema representation,
 * which is what MCP's tool listing needs to describe an argument, so listing a tool built
 * straight from `listMessagesSchema` or `createExportSchema` throws. This swaps just those two
 * fields for a plain ISO-8601 string, keeping the exact wording `.describe()` already carries on
 * the real schema — the route still does its own `z.coerce.date()` on whatever string a tool
 * call sends, so the actual coercion rule lives in exactly one place.
 */
function withStringTimestamps<Shape extends { since: z.ZodType; until: z.ZodType }>(schema: z.ZodObject<Shape>) {
  return schema.extend({
    since: z.iso.datetime({ offset: true }).optional().describe(schema.shape.since.description ?? ""),
    until: z.iso.datetime({ offset: true }).optional().describe(schema.shape.until.description ?? ""),
  });
}

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
const CREATES: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
const UPDATES: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };
const CHECKS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };
const DESTROYS: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true };

const DECLARED_TOOLS: McpToolDefinition[] = [
  {
    name: "create_domain",
    route: route("POST", "/v1/domains"),
    inputSchema: createDomainSchema,
    handler: domainsPOST,
    pathParams: [],
    payload: "body",
    annotations: CREATES,
  },
  {
    name: "list_domains",
    route: route("GET", "/v1/domains"),
    inputSchema: listDomainsSchema,
    handler: domainsGET,
    pathParams: [],
    payload: "query",
    annotations: READ_ONLY,
  },
  {
    name: "read_domain",
    route: route("GET", "/v1/domains/:id"),
    inputSchema: z.object({ id: idField("domain") }),
    handler: domainGET,
    pathParams: ["id"],
    payload: "none",
    annotations: READ_ONLY,
  },
  {
    name: "move_domain",
    route: route("PATCH", "/v1/domains/:id"),
    inputSchema: patchDomainSchema.extend({ id: idField("domain") }),
    handler: domainPATCH,
    pathParams: ["id"],
    payload: "body",
    annotations: UPDATES,
  },
  {
    name: "verify_domain",
    route: route("POST", "/v1/domains/:id/verify"),
    inputSchema: z.object({ id: idField("domain") }),
    handler: domainVerifyPOST,
    pathParams: ["id"],
    payload: "none",
    annotations: CHECKS,
  },
  {
    name: "delete_domain",
    route: route("DELETE", "/v1/domains/:id"),
    inputSchema: z.object({ id: idField("domain") }),
    handler: domainDELETE,
    pathParams: ["id"],
    payload: "none",
    annotations: DESTROYS,
  },
  {
    name: "read_reputation",
    route: route("GET", "/v1/reputation"),
    inputSchema: z.object({}),
    handler: reputationGET,
    pathParams: [],
    payload: "none",
    annotations: READ_ONLY,
  },
  {
    name: "read_stats",
    route: route("GET", "/v1/stats"),
    inputSchema: withStringTimestamps(statsQueryFields).extend({
      status: z.array(z.enum(MESSAGE_STATUSES)).optional().describe("Only messages with one of these statuses."),
    }),
    handler: statsGET,
    pathParams: [],
    payload: "query",
    annotations: READ_ONLY,
  },
  {
    name: "send_email",
    route: route("POST", "/v1/emails"),
    inputSchema: sendEmailSchema,
    handler: emailsPOST,
    pathParams: [],
    payload: "body",
    annotations: CREATES,
  },
  {
    name: "list_emails",
    route: route("GET", "/v1/emails"),
    inputSchema: withStringTimestamps(listMessagesSchema).extend({
      status: z.array(z.enum(MESSAGE_STATUSES)).optional().describe("Only messages with one of these statuses."),
    }),
    handler: emailsGET,
    pathParams: [],
    payload: "query",
    annotations: READ_ONLY,
  },
  {
    name: "read_email",
    route: route("GET", "/v1/emails/:id"),
    inputSchema: z.object({ id: idField("message") }),
    handler: emailGET,
    pathParams: ["id"],
    payload: "query",
    annotations: READ_ONLY,
  },
  {
    name: "resend_email",
    route: route("POST", "/v1/emails/:id/resend"),
    inputSchema: z.object({ id: idField("message") }),
    handler: emailResendPOST,
    pathParams: ["id"],
    payload: "none",
    annotations: CREATES,
  },
  {
    name: "watch_email",
    route: route("GET", "/v1/emails/:id/events"),
    inputSchema: z.object({ id: idField("message") }),
    handler: emailEventsGET,
    pathParams: ["id"],
    payload: "none",
    annotations: READ_ONLY,
    stream: true,
  },
  {
    name: "list_providers",
    route: route("GET", "/v1/providers"),
    inputSchema: listProvidersSchema,
    handler: providersGET,
    pathParams: [],
    payload: "query",
    annotations: READ_ONLY,
  },
  {
    name: "read_provider",
    route: route("GET", "/v1/providers/:id"),
    inputSchema: z.object({ id: idField("provider") }),
    handler: providerGET,
    pathParams: ["id"],
    payload: "none",
    annotations: READ_ONLY,
  },
  {
    name: "import_suppressions",
    route: route("POST", "/v1/suppressions"),
    inputSchema: importSuppressionsSchema,
    handler: suppressionsPOST,
    pathParams: [],
    payload: "body",
    // A repeat adds nothing: an address already suppressed keeps its row.
    annotations: { ...CREATES, idempotentHint: true },
  },
  {
    name: "list_suppressions",
    route: route("GET", "/v1/suppressions"),
    inputSchema: withStringTimestamps(listSuppressionsSchema),
    handler: suppressionsGET,
    pathParams: [],
    payload: "query",
    annotations: READ_ONLY,
  },
  {
    name: "read_suppression",
    route: route("GET", "/v1/suppressions/:address"),
    inputSchema: z.object({
      address: z.string().min(3).describe("The suppression's id, or the address, matched on its normalized form."),
    }),
    handler: suppressionGET,
    pathParams: ["address"],
    payload: "none",
    annotations: READ_ONLY,
  },
  {
    name: "remove_suppression",
    route: route("DELETE", "/v1/suppressions/:address"),
    inputSchema: z.object({
      address: z.string().min(3).describe("Address to take off the list, matched on its normalized form."),
    }),
    handler: suppressionDELETE,
    pathParams: ["address"],
    payload: "none",
    annotations: DESTROYS,
  },
  {
    name: "read_recipient",
    route: route("GET", "/v1/recipients/:address"),
    inputSchema: z.object({
      address: z.string().min(3).describe("The address, matched on its normalized form."),
    }),
    handler: recipientGET,
    pathParams: ["address"],
    payload: "none",
    annotations: READ_ONLY,
  },
  {
    name: "create_export",
    route: route("POST", "/v1/exports"),
    inputSchema: withStringTimestamps(createExportSchema),
    handler: exportsPOST,
    pathParams: [],
    payload: "body",
    annotations: CREATES,
  },
  {
    name: "list_exports",
    route: route("GET", "/v1/exports"),
    inputSchema: listExportsSchema,
    handler: exportsGET,
    pathParams: [],
    payload: "query",
    annotations: READ_ONLY,
  },
  {
    name: "read_export",
    route: route("GET", "/v1/exports/:id"),
    inputSchema: z.object({ id: idField("export") }),
    handler: exportGET,
    pathParams: ["id"],
    payload: "none",
    annotations: READ_ONLY,
  },
  {
    name: "create_list",
    route: route("POST", "/v1/lists"),
    inputSchema: createListSchema,
    handler: listsPOST,
    pathParams: [],
    payload: "body",
    annotations: CREATES,
  },
  {
    name: "list_lists",
    route: route("GET", "/v1/lists"),
    inputSchema: listListsSchema,
    handler: listsGET,
    pathParams: [],
    payload: "query",
    annotations: READ_ONLY,
  },
  {
    name: "read_list",
    route: route("GET", "/v1/lists/:id"),
    inputSchema: z.object({ id: idField("list") }),
    handler: listGET,
    pathParams: ["id"],
    payload: "none",
    annotations: READ_ONLY,
  },
  {
    name: "update_list",
    route: route("PATCH", "/v1/lists/:id"),
    inputSchema: updateListSchema.extend({ id: idField("list") }),
    handler: listPATCH,
    pathParams: ["id"],
    payload: "body",
    annotations: UPDATES,
  },
  {
    name: "delete_list",
    route: route("DELETE", "/v1/lists/:id"),
    inputSchema: z.object({ id: idField("list") }),
    handler: listDELETE,
    pathParams: ["id"],
    payload: "none",
    annotations: DESTROYS,
  },
  {
    name: "add_list_member",
    route: route("POST", "/v1/lists/:id/members"),
    inputSchema: addMemberSchema.extend({ id: idField("list") }),
    handler: membersPOST,
    pathParams: ["id"],
    payload: "body",
    // An address already on the list keeps its membership.
    annotations: { ...CREATES, idempotentHint: true },
  },
  {
    name: "import_list_members",
    route: route("POST", "/v1/lists/:id/members"),
    inputSchema: importMembersSchema.extend({ id: idField("list") }),
    handler: membersPOST,
    pathParams: ["id"],
    payload: "body",
    annotations: { ...CREATES, idempotentHint: true },
  },
  {
    name: "list_list_members",
    route: route("GET", "/v1/lists/:id/members"),
    inputSchema: listMembersSchema.extend({ id: idField("list") }),
    handler: membersGET,
    pathParams: ["id"],
    payload: "query",
    annotations: READ_ONLY,
  },
  {
    name: "update_list_member",
    route: route("PATCH", "/v1/lists/:id/members/:memberId"),
    inputSchema: updateMemberSchema.extend({ id: idField("list"), memberId: idField("membership") }),
    handler: memberPATCH,
    pathParams: ["id", "memberId"],
    payload: "body",
    annotations: UPDATES,
  },
  {
    name: "remove_list_member",
    route: route("DELETE", "/v1/lists/:id/members/:memberId"),
    inputSchema: z.object({ id: idField("list"), memberId: idField("membership") }),
    handler: memberDELETE,
    pathParams: ["id", "memberId"],
    payload: "none",
    annotations: DESTROYS,
  },
  {
    name: "export_list_members",
    route: route("GET", "/v1/lists/:id/export"),
    inputSchema: z.object({ id: idField("list") }),
    handler: listExportGET,
    pathParams: ["id"],
    payload: "none",
    annotations: READ_ONLY,
  },
  {
    name: "unsubscribe_from_list",
    route: route("POST", "/v1/lists/:id/unsubscribe"),
    inputSchema: unsubscribeAddressSchema.extend({ id: idField("list") }),
    handler: listUnsubscribePOST,
    pathParams: ["id"],
    payload: "body",
    // No API call resubscribes the address.
    annotations: DESTROYS,
  },
  {
    name: "unsubscribe_from_domain",
    route: route("POST", "/v1/domains/:id/unsubscribe"),
    inputSchema: unsubscribeAddressSchema.extend({ id: idField("domain") }),
    handler: domainUnsubscribePOST,
    pathParams: ["id"],
    payload: "body",
    annotations: DESTROYS,
  },
  {
    name: "send_batch",
    route: route("POST", "/v1/batches"),
    inputSchema: createBatchSchema,
    handler: batchesPOST,
    pathParams: [],
    payload: "body",
    annotations: CREATES,
  },
  {
    name: "read_batch",
    route: route("GET", "/v1/batches/:id"),
    inputSchema: z.object({ id: idField("batch") }),
    handler: batchGET,
    pathParams: ["id"],
    payload: "none",
    annotations: READ_ONLY,
  },
  {
    name: "list_inbound",
    route: route("GET", "/v1/inbound"),
    inputSchema: listInboundSchema,
    handler: inboundGET,
    pathParams: [],
    payload: "query",
    annotations: READ_ONLY,
  },
  {
    name: "read_inbound",
    route: route("GET", "/v1/inbound/:id"),
    inputSchema: z.object({ id: idField("inbound message") }),
    handler: inboundMessageGET,
    pathParams: ["id"],
    payload: "query",
    annotations: READ_ONLY,
  },
  {
    name: "read_domain_inbound",
    route: route("GET", "/v1/domains/:id/inbound"),
    inputSchema: z.object({ id: idField("domain") }),
    handler: domainInboundGET,
    pathParams: ["id"],
    payload: "none",
    annotations: READ_ONLY,
  },
  {
    name: "update_domain_inbound",
    route: route("PATCH", "/v1/domains/:id/inbound"),
    inputSchema: updateInboundSchema.extend({ id: idField("domain") }),
    handler: domainInboundPATCH,
    pathParams: ["id"],
    payload: "body",
    // Every call with webhook_url issues a new signing secret, invalidating the old one.
    annotations: { ...DESTROYS, idempotentHint: false },
  },
  {
    name: "list_dmarc_reports",
    route: route("GET", "/v1/domains/:id/dmarc_reports"),
    inputSchema: listDmarcReportsSchema.extend({ id: idField("domain") }),
    handler: domainDmarcReportsGET,
    pathParams: ["id"],
    payload: "query",
    annotations: READ_ONLY,
  },
  {
    name: "create_address",
    route: route("POST", "/v1/addresses"),
    inputSchema: createAddressSchema,
    handler: addressesPOST,
    pathParams: [],
    payload: "body",
    annotations: CREATES,
  },
  {
    name: "list_addresses",
    route: route("GET", "/v1/addresses"),
    inputSchema: listAddressesSchema,
    handler: addressesGET,
    pathParams: [],
    payload: "query",
    annotations: READ_ONLY,
  },
  {
    name: "read_address",
    route: route("GET", "/v1/addresses/:id"),
    inputSchema: z.object({ id: idField("address") }),
    handler: addressGET,
    pathParams: ["id"],
    payload: "none",
    annotations: READ_ONLY,
  },
  {
    name: "update_address",
    route: route("PATCH", "/v1/addresses/:id"),
    inputSchema: updateAddressSchema.extend({ id: idField("address") }),
    handler: addressPATCH,
    pathParams: ["id"],
    payload: "body",
    // expires_in counts from the call, so a repeat moves the expiry again.
    annotations: { ...UPDATES, idempotentHint: false },
  },
  {
    name: "revoke_address",
    route: route("DELETE", "/v1/addresses/:id"),
    inputSchema: z.object({ id: idField("address") }),
    handler: addressDELETE,
    pathParams: ["id"],
    payload: "none",
    annotations: DESTROYS,
  },
  {
    name: "list_address_messages",
    route: route("GET", "/v1/addresses/:id/messages"),
    inputSchema: listAddressMessagesSchema.extend({ id: idField("address") }),
    handler: addressMessagesGET,
    pathParams: ["id"],
    payload: "query",
    annotations: READ_ONLY,
  },
  {
    name: "wait_for_mail",
    route: route("GET", "/v1/addresses/:id/messages"),
    inputSchema: z.object({
      id: idField("address"),
      after: listAddressMessagesSchema.shape.after,
      wait: z
        .number()
        .int()
        .min(1)
        .max(ADDRESS_WAIT_MAX_SECONDS)
        .default(ADDRESS_WAIT_MAX_SECONDS)
        .describe(`Seconds to wait, up to ${ADDRESS_WAIT_MAX_SECONDS}. An empty data array means nothing arrived; call again to keep waiting.`),
    }),
    handler: addressMessagesGET,
    pathParams: ["id"],
    payload: "query",
    annotations: READ_ONLY,
  },
  {
    name: "reply_from_address",
    route: route("POST", "/v1/addresses/:id/reply"),
    inputSchema: replyFromAddressSchema.extend({ id: idField("address") }),
    handler: addressReplyPOST,
    pathParams: ["id"],
    payload: "body",
    annotations: CREATES,
  },
  {
    name: "add_forward_target",
    route: route("POST", "/v1/addresses/:id/forward_targets"),
    inputSchema: addForwardTargetSchema.extend({ id: idField("address") }),
    handler: forwardTargetsPOST,
    pathParams: ["id"],
    payload: "body",
    annotations: CREATES,
  },
  {
    name: "list_forward_targets",
    route: route("GET", "/v1/addresses/:id/forward_targets"),
    inputSchema: z.object({ id: idField("address") }),
    handler: forwardTargetsGET,
    pathParams: ["id"],
    payload: "none",
    annotations: READ_ONLY,
  },
  {
    name: "read_forward_target",
    route: route("GET", "/v1/addresses/:id/forward_targets/:targetId"),
    inputSchema: z.object({ id: idField("address"), targetId: idField("forward target") }),
    handler: forwardTargetGET,
    pathParams: ["id", "targetId"],
    payload: "none",
    annotations: READ_ONLY,
  },
  {
    name: "remove_forward_target",
    route: route("DELETE", "/v1/addresses/:id/forward_targets/:targetId"),
    inputSchema: z.object({ id: idField("address"), targetId: idField("forward target") }),
    handler: forwardTargetDELETE,
    pathParams: ["id", "targetId"],
    payload: "none",
    annotations: DESTROYS,
  },
  {
    name: "resend_forward_confirmation",
    route: route("POST", "/v1/addresses/:id/forward_targets/:targetId/resend_confirmation"),
    inputSchema: z.object({ id: idField("address"), targetId: idField("forward target") }),
    handler: forwardTargetResendPOST,
    pathParams: ["id", "targetId"],
    payload: "none",
    // Each call mails a new link and kills the old one.
    annotations: { ...UPDATES, idempotentHint: false },
  },
  {
    name: "create_key",
    route: route("POST", "/v1/keys"),
    inputSchema: createKeySchema,
    handler: keysPOST,
    pathParams: [],
    payload: "body",
    annotations: CREATES,
  },
  {
    name: "list_keys",
    route: route("GET", "/v1/keys"),
    inputSchema: listKeysSchema,
    handler: keysGET,
    pathParams: [],
    payload: "query",
    annotations: READ_ONLY,
  },
  {
    name: "read_key",
    route: route("GET", "/v1/keys/:id"),
    inputSchema: z.object({ id: idField("key") }),
    handler: keyGET,
    pathParams: ["id"],
    payload: "none",
    annotations: READ_ONLY,
  },
  {
    name: "update_key",
    route: route("PATCH", "/v1/keys/:id"),
    inputSchema: updateKeySchema.extend({ id: idField("key") }),
    handler: keyPATCH,
    pathParams: ["id"],
    payload: "body",
    annotations: UPDATES,
  },
  {
    name: "revoke_key",
    route: route("DELETE", "/v1/keys/:id"),
    inputSchema: z.object({ id: idField("key") }),
    handler: keyDELETE,
    pathParams: ["id"],
    payload: "none",
    annotations: DESTROYS,
  },
  {
    name: "create_webhook_endpoint",
    route: route("POST", "/v1/webhook_endpoints"),
    inputSchema: createWebhookEndpointSchema,
    handler: endpointsPOST,
    pathParams: [],
    payload: "body",
    annotations: CREATES,
  },
  {
    name: "list_webhook_endpoints",
    route: route("GET", "/v1/webhook_endpoints"),
    inputSchema: listWebhookEndpointsSchema,
    handler: endpointsGET,
    pathParams: [],
    payload: "query",
    annotations: READ_ONLY,
  },
  {
    name: "read_webhook_endpoint",
    route: route("GET", "/v1/webhook_endpoints/:id"),
    inputSchema: z.object({ id: idField("webhook endpoint") }),
    handler: endpointGET,
    pathParams: ["id"],
    payload: "none",
    annotations: READ_ONLY,
  },
  {
    name: "update_webhook_endpoint",
    route: route("PATCH", "/v1/webhook_endpoints/:id"),
    inputSchema: updateWebhookEndpointSchema.extend({ id: idField("webhook endpoint") }),
    handler: endpointPATCH,
    pathParams: ["id"],
    payload: "body",
    annotations: UPDATES,
  },
  {
    name: "delete_webhook_endpoint",
    route: route("DELETE", "/v1/webhook_endpoints/:id"),
    inputSchema: z.object({ id: idField("webhook endpoint") }),
    handler: endpointDELETE,
    pathParams: ["id"],
    payload: "none",
    annotations: DESTROYS,
  },
  {
    name: "rotate_webhook_secret",
    route: route("POST", "/v1/webhook_endpoints/:id/rotate_secret"),
    inputSchema: z.object({ id: idField("webhook endpoint") }),
    handler: endpointRotatePOST,
    pathParams: ["id"],
    payload: "none",
    // The old secret stops verifying, so a receiver still holding it rejects the next event.
    annotations: DESTROYS,
  },
  {
    name: "list_webhook_deliveries",
    route: route("GET", "/v1/webhook_endpoints/:id/deliveries"),
    inputSchema: listWebhookDeliveriesSchema.extend({ id: idField("webhook endpoint") }),
    handler: endpointDeliveriesGET,
    pathParams: ["id"],
    payload: "query",
    annotations: READ_ONLY,
  },
  {
    name: "read_webhook_delivery",
    route: route("GET", "/v1/webhook_endpoints/:id/deliveries/:deliveryId"),
    inputSchema: z.object({ id: idField("webhook endpoint"), deliveryId: idField("webhook delivery") }),
    handler: endpointDeliveryGET,
    pathParams: ["id", "deliveryId"],
    payload: "none",
    annotations: READ_ONLY,
  },
  {
    name: "list_activity",
    route: route("GET", "/v1/activity"),
    inputSchema: listActivitySchema.extend({
      since: z.iso.datetime({ offset: true }).optional().describe(listActivitySchema.shape.since.description ?? ""),
    }),
    handler: activityListGET,
    pathParams: [],
    payload: "query",
    annotations: READ_ONLY,
  },
  {
    name: "read_activity",
    route: route("GET", "/v1/activity/:id"),
    inputSchema: z.object({ id: idField("activity entry") }),
    handler: activityGET,
    pathParams: ["id"],
    payload: "none",
    annotations: READ_ONLY,
  },
  {
    name: "read_organization",
    route: route("GET", "/v1/organization"),
    inputSchema: z.object({}),
    handler: organizationGET,
    pathParams: [],
    payload: "none",
    annotations: READ_ONLY,
  },
  {
    name: "update_organization",
    route: route("PATCH", "/v1/organization"),
    inputSchema: updateOrganizationSettingsSchema,
    handler: organizationPATCH,
    pathParams: [],
    payload: "body",
    annotations: UPDATES,
  },
  {
    name: "list_admin_providers",
    route: route("GET", "/v1/admin/providers"),
    inputSchema: listAdminProvidersSchema,
    handler: adminProvidersGET,
    pathParams: [],
    payload: "query",
    annotations: READ_ONLY,
    admin: true,
  },
  {
    name: "read_admin_provider",
    route: route("GET", "/v1/admin/providers/:id"),
    inputSchema: z.object({ id: idField("provider") }),
    handler: adminProviderGET,
    pathParams: ["id"],
    payload: "none",
    annotations: READ_ONLY,
    admin: true,
  },
  {
    name: "create_admin_provider",
    route: route("POST", "/v1/admin/providers"),
    inputSchema: createAdminProviderSchema,
    handler: adminProvidersPOST,
    pathParams: [],
    payload: "body",
    annotations: CREATES,
    admin: true,
  },
  {
    name: "update_admin_provider",
    route: route("PATCH", "/v1/admin/providers/:id"),
    inputSchema: patchAdminProviderSchema.extend({ id: idField("provider") }),
    handler: adminProviderPATCH,
    pathParams: ["id"],
    payload: "body",
    annotations: UPDATES,
    admin: true,
  },
  {
    name: "test_admin_provider",
    route: route("POST", "/v1/admin/providers/:id/test"),
    inputSchema: z.object({ id: idField("provider") }),
    handler: adminProviderTestPOST,
    pathParams: ["id"],
    payload: "none",
    // Records the verdict as a probe, and changes nothing else.
    annotations: { ...CHECKS, readOnlyHint: true },
    admin: true,
  },
  {
    name: "setup_admin_provider",
    route: route("POST", "/v1/admin/providers/:id/setup"),
    inputSchema: z.object({ id: idField("provider") }),
    handler: adminProviderSetupPOST,
    pathParams: ["id"],
    payload: "none",
    annotations: UPDATES,
    admin: true,
  },
  {
    name: "read_admin_conversion",
    route: route("GET", "/v1/admin/providers/:id/convert"),
    inputSchema: z.object({ id: idField("provider") }),
    handler: adminConvertGET,
    pathParams: ["id"],
    payload: "none",
    annotations: READ_ONLY,
    admin: true,
  },
  {
    name: "convert_admin_provider",
    route: route("POST", "/v1/admin/providers/:id/convert"),
    inputSchema: z.object({ id: idField("provider") }),
    handler: adminConvertPOST,
    pathParams: ["id"],
    payload: "none",
    // Undone only by hand in SQL and AWS.
    annotations: DESTROYS,
    admin: true,
  },
  {
    name: "delete_admin_provider",
    route: route("DELETE", "/v1/admin/providers/:id"),
    inputSchema: z.object({ id: idField("provider") }),
    handler: adminProviderDELETE,
    pathParams: ["id"],
    payload: "none",
    annotations: DESTROYS,
    admin: true,
  },
  {
    name: "adopt_admin_domain",
    route: route("POST", "/v1/admin/domains"),
    inputSchema: adoptDomainSchema,
    handler: adminDomainsPOST,
    pathParams: [],
    payload: "body",
    annotations: CREATES,
    admin: true,
  },
  {
    name: "list_provider_organizations",
    route: route("GET", "/v1/admin/providers/:id/organizations"),
    inputSchema: listProviderOrganizationsSchema.extend({ id: idField("provider") }),
    handler: adminAssignmentsGET,
    pathParams: ["id"],
    payload: "query",
    annotations: READ_ONLY,
    admin: true,
  },
  {
    name: "assign_organization",
    route: route("POST", "/v1/admin/providers/:id/organizations"),
    inputSchema: assignOrganizationSchema.extend({ id: idField("provider") }),
    handler: adminAssignmentsPOST,
    pathParams: ["id"],
    payload: "body",
    // Assigning again returns the existing assignment.
    annotations: { ...CREATES, idempotentHint: true },
    admin: true,
  },
  {
    name: "unassign_organization",
    route: route("DELETE", "/v1/admin/providers/:id/organizations/:organizationId"),
    inputSchema: z.object({ id: idField("provider"), organizationId: idField("organization") }),
    handler: adminAssignmentDELETE,
    pathParams: ["id", "organizationId"],
    payload: "none",
    annotations: DESTROYS,
    admin: true,
  },
  {
    name: "list_admin_organizations",
    route: route("GET", "/v1/admin/organizations"),
    inputSchema: listAdminOrganizationsSchema,
    handler: adminOrganizationsGET,
    pathParams: [],
    payload: "query",
    annotations: READ_ONLY,
    admin: true,
  },
  {
    name: "read_admin_organization",
    route: route("GET", "/v1/admin/organizations/:id"),
    inputSchema: z.object({ id: idField("organization") }),
    handler: adminOrganizationGET,
    pathParams: ["id"],
    payload: "none",
    annotations: READ_ONLY,
    admin: true,
  },
  {
    name: "update_admin_organization",
    route: route("PATCH", "/v1/admin/organizations/:id"),
    inputSchema: patchAdminOrganizationSchema.extend({ id: idField("organization") }),
    handler: adminOrganizationPATCH,
    pathParams: ["id"],
    payload: "body",
    annotations: UPDATES,
    admin: true,
  },
  {
    name: "delete_admin_organization",
    route: route("DELETE", "/v1/admin/organizations/:id"),
    inputSchema: z.object({ id: idField("organization") }),
    handler: adminOrganizationDELETE,
    pathParams: ["id"],
    payload: "none",
    // Its domains, keys, people and send history go with it.
    annotations: DESTROYS,
    admin: true,
  },
  {
    name: "suspend_organization",
    route: route("POST", "/v1/admin/organizations/:id/suspend"),
    inputSchema: suspendOrganizationSchema.extend({ id: idField("organization") }),
    handler: adminSuspendPOST,
    pathParams: ["id"],
    payload: "body",
    // A manual suspension fails the organization's queued mail.
    annotations: DESTROYS,
    admin: true,
  },
  {
    name: "release_organization",
    route: route("POST", "/v1/admin/organizations/:id/release"),
    inputSchema: z.object({ id: idField("organization") }),
    handler: adminReleasePOST,
    pathParams: ["id"],
    payload: "none",
    annotations: UPDATES,
    admin: true,
  },
  {
    name: "create_admin_organization",
    route: route("POST", "/v1/admin/organizations"),
    inputSchema: createAdminOrganizationSchema,
    handler: adminOrganizationsPOST,
    pathParams: [],
    payload: "body",
    annotations: CREATES,
    admin: true,
  },
  {
    name: "list_organization_members",
    route: route("GET", "/v1/admin/organizations/:id/members"),
    inputSchema: listMembershipsSchema.extend({ id: idField("organization") }),
    handler: adminMembersGET,
    pathParams: ["id"],
    payload: "query",
    annotations: READ_ONLY,
    admin: true,
  },
  {
    name: "update_organization_member",
    route: route("PATCH", "/v1/admin/organizations/:id/members/:userId"),
    inputSchema: patchMembershipSchema.extend({ id: idField("organization"), userId: idField("account") }),
    handler: adminMemberPATCH,
    pathParams: ["id", "userId"],
    payload: "body",
    annotations: UPDATES,
    admin: true,
  },
  {
    name: "remove_organization_member",
    route: route("DELETE", "/v1/admin/organizations/:id/members/:userId"),
    inputSchema: z.object({ id: idField("organization"), userId: idField("account") }),
    handler: adminMemberDELETE,
    pathParams: ["id", "userId"],
    payload: "none",
    annotations: DESTROYS,
    admin: true,
  },
  {
    name: "invite_to_organization",
    route: route("POST", "/v1/admin/organizations/:id/invitations"),
    inputSchema: createInvitationSchema.extend({ id: idField("organization") }),
    handler: adminInvitationsPOST,
    pathParams: ["id"],
    payload: "body",
    // Sends mail to the address it's given.
    annotations: CREATES,
    admin: true,
  },
  {
    name: "list_organization_invitations",
    route: route("GET", "/v1/admin/organizations/:id/invitations"),
    inputSchema: listInvitationsSchema.extend({ id: idField("organization") }),
    handler: adminInvitationsGET,
    pathParams: ["id"],
    payload: "query",
    annotations: READ_ONLY,
    admin: true,
  },
  {
    name: "revoke_organization_invitation",
    route: route("DELETE", "/v1/admin/organizations/:id/invitations/:invitationId"),
    inputSchema: z.object({ id: idField("organization"), invitationId: idField("invitation") }),
    handler: adminInvitationDELETE,
    pathParams: ["id", "invitationId"],
    payload: "none",
    annotations: DESTROYS,
    admin: true,
  },
  {
    name: "resend_organization_invitation",
    route: route("POST", "/v1/admin/organizations/:id/invitations/:invitationId/resend"),
    inputSchema: z.object({ id: idField("organization"), invitationId: idField("invitation") }),
    handler: adminInvitationResendPOST,
    pathParams: ["id", "invitationId"],
    payload: "none",
    // Every call mails a new token and kills the previous link.
    annotations: { ...DESTROYS, idempotentHint: false },
    admin: true,
  },
  {
    name: "list_admin_users",
    route: route("GET", "/v1/admin/users"),
    inputSchema: listAdminUsersSchema,
    handler: adminUsersGET,
    pathParams: [],
    payload: "query",
    annotations: READ_ONLY,
    admin: true,
  },
  {
    name: "read_admin_user",
    route: route("GET", "/v1/admin/users/:id"),
    inputSchema: z.object({ id: idField("account") }),
    handler: adminUserGET,
    pathParams: ["id"],
    payload: "none",
    annotations: READ_ONLY,
    admin: true,
  },
  {
    name: "update_admin_user",
    route: route("PATCH", "/v1/admin/users/:id"),
    inputSchema: patchAdminUserSchema.extend({ id: idField("account") }),
    handler: adminUserPATCH,
    pathParams: ["id"],
    payload: "body",
    // Revoking the flag revokes the admin keys that account created.
    annotations: DESTROYS,
    admin: true,
  },
  {
    name: "delete_admin_user",
    route: route("DELETE", "/v1/admin/users/:id"),
    inputSchema: z.object({ id: idField("account") }),
    handler: adminUserDELETE,
    pathParams: ["id"],
    payload: "none",
    annotations: DESTROYS,
    admin: true,
  },
];

/**
 * A tool over a GET route with a response shape takes that shape's `include` and `fields` as
 * arrays. Built from the tool's own object shape, so a refinement on it is left to the route.
 */
function withShapeArgs(tool: McpToolDefinition): McpToolDefinition {
  const shape = tool.route.method === "GET" ? shapeFor(tool.route.method, tool.route.path) : undefined;
  if (!shape) return tool;
  if (!(tool.inputSchema instanceof z.ZodObject)) throw new Error(`lib/mcp/registry: ${tool.name} needs an object input schema to take fields.`);
  return { ...tool, inputSchema: z.object({ ...tool.inputSchema.shape, ...shapeToolArgs(shape) }), payload: "query" };
}

export const MCP_TOOLS: McpToolDefinition[] = DECLARED_TOOLS.map(withShapeArgs);
