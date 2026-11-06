import { ZodError } from "zod";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy, readCapped, readJson } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { listFor, type ListCaller } from "@/lib/lists";
import { addMembership, listMembers } from "@/lib/lists/members";
import { importCounts, importMemberCsv, importMembers, recordImportActivity } from "@/lib/lists/import";
import { serializeMembership } from "@/lib/lists/serialize";
import { addMemberSchema, importMembersSchema, listMembersSchema } from "@/lib/schemas/list";
import { validationError } from "@/lib/schemas/validation-error";
import { projectPage, selectShape } from "@/lib/api/shape";
import { listMemberShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

function callerFor(key: OrganizationKeyRow): ListCaller {
  return { organizationId: key.organizationId, domainIds: key.domainIds, actor: apiKeyActor(key.id, key.name) };
}

/**
 * A single `{ address, ... }` JSON body adds one member. A `{ members: [...] }` JSON body, or a
 * `text/csv` body, imports many at once through the same `lib/lists/import.ts` — see
 * docs/api/conventions.md's "Create, import by API and CSV". A row that fails is reported by
 * address (and line, for CSV) rather than aborting the rest of the file.
 */
async function post(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  const caller = callerFor(key);
  const list = await listFor(caller, id);

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("text/csv")) {
    const result = await importMemberCsv(caller, list, await readCapped(request));
    return json({ imported: result.imported, ...importCounts(result), errors: result.errors }, 200);
  }

  const body = await readJson(request);

  if (body && typeof body === "object" && "members" in body) {
    try {
      const { members, confirmed } = importMembersSchema.parse(body);
      const result = await importMembers({
        organizationId: caller.organizationId,
        listId: list.id,
        doubleOptIn: list.doubleOptIn,
        rows: members,
        defaultConfirmed: confirmed,
      });
      await recordImportActivity(caller, list, result);
      return json({ imported: result.imported, ...importCounts(result), errors: result.errors }, 200);
    } catch (error) {
      if (error instanceof ZodError) throw validationError(error, body);
      throw error;
    }
  }

  try {
    const parsed = addMemberSchema.parse(body);
    const { membership } = await addMembership({
      organizationId: caller.organizationId,
      listId: list.id,
      address: parsed.address,
      source: parsed.source === "import" ? "import" : "manual",
      doubleOptIn: list.doubleOptIn,
      attributes: parsed.attributes,
      manualActor: parsed.source === "manual" ? caller.actor.label : undefined,
      confirmed: parsed.confirmed,
      record: { actor: caller.actor, listName: list.name },
    });
    return json(serializeMembership(membership), 201);
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, body);
    throw error;
  }
}

async function get(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  const query = Object.fromEntries(new URL(request.url).searchParams);
  try {
    const { limit, cursor, status, fields } = listMembersSchema.parse(query);
    return json(projectPage(await listMembers(callerFor(key), id, limit, cursor, { status }), selectShape(listMemberShape, { fields })));
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, query);
    throw error;
  }
}

export const POST = withApiKey<Context>(post);
export const GET = withApiKey<Context>(get);

const { rejected, options } = methodPolicy("POST", "GET");
export const PATCH = rejected;
export const PUT = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
