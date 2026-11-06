/**
 * #565: a sign-in method that's off is refused at its own Better Auth endpoint, not only hidden
 * on /login, and the write path keeps one method on and every admin able to sign in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, passkeys, sessions, users, verifications } from "@/lib/db/schema";
import { auth } from "@/lib/auth";
import { adminActor } from "@/lib/activity/record";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { settleAuthBackgroundTasks } from "@/lib/auth/password-reset";
import { createAccountWithPassword } from "@/lib/auth/provisioning";
import { enabledSignInMethods, SIGN_IN_METHOD_DISABLED } from "@/lib/auth/sign-in-methods";
import { readStoredSettings, setSystemFromAddress } from "@/lib/settings/service";
import { setSetting } from "@/lib/settings/values";
import { GET, POST } from "@/app/api/auth/[...all]/route";
import { NO_SYSTEM_FROM_ADDRESS, resetDatabase, seedFixture, seedSystemOrganization, systemMailMessages } from "./fixtures";

const ORIGIN = process.env.APP_URL ?? "http://localhost:3100";
const EMAIL = "admin@example.net";
const PASSWORD = "correct horse battery staple";
const ADMIN = adminActor("usr_admin", "Admin");

let organizationId: string;
let adminId: string;

function headers(): Headers {
  return new Headers({ "content-type": "application/json", "x-forwarded-for": "203.0.113.20", origin: ORIGIN });
}

function post(path: string, body: unknown): Promise<Response> {
  return POST(new Request(`${ORIGIN}/api/auth${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body) }));
}

async function refusal(response: Response): Promise<{ status: number; code?: string }> {
  const body = (await response.json().catch(() => ({}))) as { code?: string };
  return { status: response.status, code: body.code };
}

async function addPasskey(userId: string): Promise<void> {
  await db.insert(passkeys).values({
    id: `pk_${userId}`,
    userId,
    name: "Key",
    publicKey: "AA",
    credentialID: `cred_${userId}`,
    counter: 0,
    deviceType: "multiDevice",
    backedUp: true,
  });
}

beforeEach(async () => {
  await resetDatabase();
  await db.delete(verifications);
  resetRateLimitMemory();
  organizationId = (await seedFixture()).organizationId;
  await seedSystemOrganization();
  adminId = (await createAccountWithPassword({ email: EMAIL, name: "Admin", organizationId, password: PASSWORD, emailVerified: true, admin: true })).id;
  // A second way in for the admin, so turning off one method doesn't strand them.
  await addPasskey(adminId);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("password sign-in", () => {
  it("signs in while it's on: the control", async () => {
    const response = await post("/sign-in/email", { email: EMAIL, password: PASSWORD });

    expect(response.status).toBe(200);
  });

  it("is refused by /sign-in/email while it's off, with the right password, and starts no session", async () => {
    await setSetting("sign_in_password", false, ADMIN);

    expect(await refusal(await post("/sign-in/email", { email: EMAIL, password: PASSWORD }))).toEqual({ status: 403, code: SIGN_IN_METHOD_DISABLED });
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it("refuses a reset request while it's off and sends nothing", async () => {
    await setSetting("sign_in_password", false, ADMIN);

    const response = await post("/request-password-reset", { email: EMAIL, redirectTo: "/reset-password" });
    await settleAuthBackgroundTasks();

    expect(await refusal(response)).toEqual({ status: 403, code: SIGN_IN_METHOD_DISABLED });
    expect(await systemMailMessages()).toHaveLength(0);
  });

  it("is refused through auth.api too, not only over HTTP", async () => {
    await setSetting("sign_in_password", false, ADMIN);

    await expect(auth.api.signInEmail({ body: { email: EMAIL, password: PASSWORD } })).rejects.toMatchObject({ body: { code: SIGN_IN_METHOD_DISABLED } });
  });
});

describe("passkey sign-in", () => {
  it("offers options while it's on: the control", async () => {
    const response = await GET(new Request(`${ORIGIN}/api/auth/passkey/generate-authenticate-options`, { headers: headers() }));

    expect(response.status).toBe(200);
  });

  it("is refused at both of its endpoints while it's off", async () => {
    await setSetting("sign_in_passkey", false, ADMIN);

    const options = await GET(new Request(`${ORIGIN}/api/auth/passkey/generate-authenticate-options`, { headers: headers() }));
    expect(await refusal(options)).toEqual({ status: 403, code: SIGN_IN_METHOD_DISABLED });
    const verify = await post("/passkey/verify-authentication", { response: { id: "x" } });
    expect(await refusal(verify)).toEqual({ status: 403, code: SIGN_IN_METHOD_DISABLED });
  });
});

describe("passkey registration", () => {
  async function registerOptions(): Promise<Response> {
    const signedIn = await post("/sign-in/email", { email: EMAIL, password: PASSWORD });
    const h = headers();
    h.set("cookie", (signedIn.headers.get("set-cookie") ?? "").split(";")[0]!);
    return GET(new Request(`${ORIGIN}/api/auth/passkey/generate-register-options`, { headers: h }));
  }

  it("offers options to a signed-in account while passkeys are on: the control", async () => {
    expect((await registerOptions()).status).toBe(200);
  });

  it("is refused at both of its endpoints while passkeys are off", async () => {
    await setSetting("sign_in_passkey", false, ADMIN);

    expect(await refusal(await registerOptions())).toEqual({ status: 403, code: SIGN_IN_METHOD_DISABLED });
    const verify = await post("/passkey/verify-registration", { response: { id: "x" } });
    expect(await refusal(verify)).toEqual({ status: 403, code: SIGN_IN_METHOD_DISABLED });
    expect(await db.select().from(passkeys).where(eq(passkeys.userId, adminId))).toHaveLength(1);
  });
});

describe("sign-in links", () => {
  it("are refused when requested while they're off, and nothing is sent", async () => {
    await setSetting("sign_in_magic_link", false, ADMIN);

    const response = await post("/sign-in/magic-link", { email: EMAIL });
    await settleAuthBackgroundTasks();

    expect(await refusal(response)).toEqual({ status: 403, code: SIGN_IN_METHOD_DISABLED });
    expect(await systemMailMessages()).toHaveLength(0);
    expect(await db.select().from(verifications)).toHaveLength(0);
  });

  it("stop redeeming once they're off, though the link was sent while they were on", async () => {
    expect((await post("/sign-in/magic-link", { email: EMAIL })).status).toBe(200);
    await settleAuthBackgroundTasks();
    const [row] = await db.select().from(verifications);
    expect(row).toBeDefined();

    await setSetting("sign_in_magic_link", false, ADMIN);

    // The token is stored hashed, so any token reaches the guard first; a real one would too.
    await expect(auth.api.magicLinkVerify({ query: { token: "anything" }, headers: headers() })).rejects.toMatchObject({
      body: { code: SIGN_IN_METHOD_DISABLED },
    });
    expect(await db.select().from(verifications)).toHaveLength(1);
  });
});

describe("turning methods off", () => {
  it("refuses the last one that's on, and stores nothing", async () => {
    await setSetting("sign_in_magic_link", false, ADMIN);
    await setSetting("sign_in_passkey", false, ADMIN);

    await expect(setSetting("sign_in_password", false, ADMIN)).rejects.toMatchObject({ code: "validation_failed" });
    expect((await readStoredSettings()).sign_in_password).toBeUndefined();
    expect((await enabledSignInMethods()).password).toBe(true);
  });

  it("refuses one that would leave an admin with no way in, naming them", async () => {
    await db.delete(passkeys).where(eq(passkeys.userId, adminId));
    await setSetting("sign_in_magic_link", false, ADMIN);

    await expect(setSetting("sign_in_password", false, ADMIN)).rejects.toThrow(EMAIL);
    expect((await enabledSignInMethods()).password).toBe(true);
  });

  it("counts a sign-in link as a way in only while system mail works", async () => {
    await db.delete(passkeys).where(eq(passkeys.userId, adminId));

    await setSetting("sign_in_password", false, ADMIN);
    expect((await enabledSignInMethods()).password).toBe(false);

    await setSetting("sign_in_password", true, ADMIN);
    await setSystemFromAddress(NO_SYSTEM_FROM_ADDRESS);
    await expect(setSetting("sign_in_password", false, ADMIN)).rejects.toThrow(EMAIL);
  });

  it("lets a member be stranded, since an admin can turn the method back on", async () => {
    const member = await createAccountWithPassword({ email: "member@example.net", name: "Member", organizationId, password: PASSWORD, emailVerified: true });
    await setSetting("sign_in_magic_link", false, ADMIN);

    await setSetting("sign_in_password", false, ADMIN);

    expect((await enabledSignInMethods()).password).toBe(false);
    expect(await db.select().from(users).where(eq(users.id, member.id))).toHaveLength(1);
  });

  it("records each change in the activity log", async () => {
    await setSetting("sign_in_passkey", false, ADMIN);

    const [row] = await db
      .select()
      .from(activity)
      .where(and(eq(activity.action, "system.setting.changed"), eq(activity.appliesTo, "sign_in_passkey")));
    expect(row?.metadata).toEqual({ setting: "sign_in_passkey", from: true, to: false });
  });

  it("leaves the password on when the environment turns all three off", async () => {
    vi.stubEnv("SIGN_IN_PASSWORD", "off");
    vi.stubEnv("SIGN_IN_PASSKEY", "off");
    vi.stubEnv("SIGN_IN_MAGIC_LINK", "off");

    expect(await enabledSignInMethods()).toEqual({ password: true, passkey: false, magic_link: false });
  });

  it("brings the password back while links are the only method and system mail isn't set up", async () => {
    vi.stubEnv("SIGN_IN_PASSWORD", "off");
    vi.stubEnv("SIGN_IN_PASSKEY", "off");
    await resetDatabase();

    expect((await enabledSignInMethods()).password).toBe(true);
  });
});
