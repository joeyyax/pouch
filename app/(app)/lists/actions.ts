"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrganizationWrite, sessionActor } from "@/lib/dashboard/session";
import { createList, deleteList, listFor, updateList, type ListCaller } from "@/lib/lists";
import { addMembership, removeMember, updateMember } from "@/lib/lists/members";
import { unsubscribeFromList } from "@/lib/lists/unsubscribe";
import { createListSchema, unsubscribeAddressSchema, updateListSchema, updateMemberSchema } from "@/lib/schemas/list";
import { failed, succeeded, type ActionState } from "@/lib/dashboard/action-state";
import { featureAction } from "@/lib/dashboard/feature-action";

async function caller(action: string): Promise<ListCaller> {
  const session = await requireOrganizationWrite(action);
  return { organizationId: session.organizationId, domainIds: [], actor: sessionActor(session) };
}

export const createListAction = featureAction("lists", async function createListAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const owner = await caller("create a list");
  if (!form.get("domain_id")) return { status: "error", message: "Choose a domain.", field: "domain_id" };
  if (!String(form.get("name") ?? "").trim()) return { status: "error", message: "Name the list.", field: "name" };
  let id: string;
  try {
    const parsed = createListSchema.parse({
      domain_id: String(form.get("domain_id") ?? ""),
      name: String(form.get("name") ?? ""),
      double_opt_in: form.get("double_opt_in") === "true",
    });
    id = (await createList(owner, parsed)).id;
  } catch (error) {
    return failed(error, "The list couldn't be created.");
  }
  revalidatePath("/lists");
  redirect(`/lists/${id}`);
});

export const updateListAction = featureAction("lists", async function updateListAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const owner = await caller("change a list");
  const id = String(form.get("id") ?? "");
  if (!String(form.get("name") ?? "").trim()) return { status: "error", message: "Name the list.", field: "name" };
  try {
    const parsed = updateListSchema.parse({
      name: String(form.get("name") ?? ""),
      double_opt_in: form.get("double_opt_in") === "true",
    });
    await updateList(owner, id, parsed);
  } catch (error) {
    return failed(error, "The list couldn't be updated.");
  }
  revalidatePath(`/lists/${id}`);
  revalidatePath("/lists");
  return succeeded("List updated.");
});

/** Attribute rows arrive as paired attribute_key/attribute_value fields, blank keys dropped. */
function attributesFrom(form: FormData): Record<string, string> {
  const keys = form.getAll("attribute_key").map(String);
  const values = form.getAll("attribute_value").map(String);
  const attributes: Record<string, string> = {};
  keys.forEach((key, index) => {
    const name = key.trim();
    if (name) attributes[name] = values[index] ?? "";
  });
  return attributes;
}

export const updateMemberAttributesAction = featureAction("lists", async function updateMemberAttributesAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const owner = await caller("change a list member's attributes");
  const listId = String(form.get("list_id") ?? "");
  const memberId = String(form.get("member_id") ?? "");
  try {
    const parsed = updateMemberSchema.parse({ attributes: attributesFrom(form) });
    await updateMember(owner, listId, memberId, parsed, owner.actor);
  } catch (error) {
    return failed(error, "The attributes couldn't be saved.");
  }
  revalidatePath(`/lists/${listId}`);
  return succeeded("Attributes saved.");
});

export const deleteListAction = featureAction("lists", async function deleteListAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const owner = await caller("delete a list");
  const id = String(form.get("id") ?? "");
  try {
    await deleteList(owner, id);
  } catch (error) {
    return failed(error, "The list couldn't be deleted.");
  }
  revalidatePath("/lists");
  redirect("/lists");
});

export const addMemberAction = featureAction("lists", async function addMemberAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const owner = await caller("add an address to a list");
  const listId = String(form.get("list_id") ?? "");
  const address = String(form.get("address") ?? "");
  try {
    const list = await listFor(owner, listId);
    const { membership } = await addMembership({
      organizationId: owner.organizationId,
      listId,
      address,
      source: "manual",
      doubleOptIn: list.doubleOptIn,
      manualActor: owner.actor.label,
      record: { actor: owner.actor, listName: list.name },
    });
    revalidatePath(`/lists/${listId}`);
    return succeeded(`${membership.address} added to the list.`);
  } catch (error) {
    return failed(error, "The address couldn't be added.");
  }
});

export const removeMemberAction = featureAction("lists", async function removeMemberAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const owner = await caller("remove a list member");
  const listId = String(form.get("list_id") ?? "");
  const memberId = String(form.get("member_id") ?? "");
  try {
    await removeMember(owner, listId, memberId, owner.actor);
  } catch (error) {
    return failed(error, "The member couldn't be removed.");
  }
  revalidatePath(`/lists/${listId}`);
  return succeeded("Member removed.");
});

export async function unsubscribeMemberAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const owner = await caller("unsubscribe an address");
  const listId = String(form.get("list_id") ?? "");
  try {
    const { address } = unsubscribeAddressSchema.parse({ address: String(form.get("address") ?? "") });
    await unsubscribeFromList(owner, listId, address);
    revalidatePath(`/lists/${listId}`);
    return succeeded(`${address} unsubscribed.`);
  } catch (error) {
    return failed(error, "The address couldn't be unsubscribed.");
  }
}
