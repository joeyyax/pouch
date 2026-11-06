"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { requireAdmin } from "@/lib/auth/admin";
import { failed, succeeded, type ActionState } from "@/lib/dashboard/action-state";
import { createAdminKey, revokeAdminKey } from "@/lib/keys/admin";
import { createAdminKeySchema } from "@/lib/schemas/key";

const PATH = "/admin/settings/api-keys";

/** The secret only exists between creation and the dialog that shows it once. */
export type CreateAdminKeyState = ActionState | { status: "created"; name: string; secret: string };

export async function createAdminKeyAction(_previous: CreateAdminKeyState, form: FormData): Promise<CreateAdminKeyState> {
  const session = await requireAdmin();

  try {
    const request = createAdminKeySchema.parse({ name: form.get("name") });
    const { key, secret } = await createAdminKey(session.user, request);

    revalidatePath(PATH);
    return { status: "created", name: key.name, secret };
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      return { status: "error", message: `Field "name" isn't valid: ${issue?.message ?? "check it"}.`, field: "name" };
    }
    return failed(error, "The admin key couldn't be created.");
  }
}

export async function revokeAdminKeyAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireAdmin();
  const id = String(form.get("id") ?? "");

  try {
    const key = await revokeAdminKey(session.user, id);

    revalidatePath(PATH);
    return succeeded(`Key ${key.name} revoked.`);
  } catch (error) {
    return failed(error, "The admin key couldn't be revoked.");
  }
}
