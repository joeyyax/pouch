"use server";

import { revalidatePath } from "next/cache";
import { requireOrganization, requireOrganizationWrite } from "@/lib/dashboard/session";
import { failed, succeeded, type ActionState } from "@/lib/dashboard/action-state";
import { readMessageBody, readMessageWithBody } from "@/lib/dashboard/messages";
import type { ApiExchange, MessageBodyView } from "@/lib/dashboard/views/messages";
import { resendFromDashboard } from "@/lib/messages/resend";

/** Sends the message again as a new one linked to it. `href` opens the copy. */
export async function resendMessageAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const { organizationId } = await requireOrganizationWrite("resend a message");
  const id = String(form.get("messageId") ?? "");

  try {
    const { message } = await resendFromDashboard(organizationId, id);
    revalidatePath("/messages", "layout");
    return succeeded("Message resent.", `/messages/${message.id}`);
  } catch (error) {
    return failed(error, "The message couldn't be resent.");
  }
}

/** The HTML and Text tabs, when one opens. */
export async function loadMessageBodyAction(id: string): Promise<MessageBodyView | null> {
  const { organizationId } = await requireOrganization();
  return readMessageBody(organizationId, id);
}

/** The JSON tab's `include=body` response, when it opens. */
export async function loadMessageWithBodyAction(id: string): Promise<ApiExchange | null> {
  const { organizationId } = await requireOrganization();
  return readMessageWithBody(organizationId, id);
}
