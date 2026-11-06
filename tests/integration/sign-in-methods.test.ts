import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, passkeys, sessions, users, verifications } from "@/lib/db/schema";
import { auth } from "@/lib/auth";
import { settleAuthBackgroundTasks } from "@/lib/auth/password-reset";
import { hashIp } from "@/lib/api/client-ip";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { readBody } from "@/lib/storage/bodies";
import { GET, POST } from "@/app/api/auth/[...all]/route";
import { resetDatabase, seedFixture, seedSystemOrganization, systemMailMessages } from "./fixtures";

const EMAIL = "owner@example.net";
const ORIGIN = process.env.APP_URL ?? "http://localhost:3100";
const IP = "203.0.113.10";
const AGENT = "Mozilla/5.0 (test)";

let organizationId: string;
let userId: string;

function headers(address = IP): Headers {
  return new Headers({ "content-type": "application/json", "x-forwarded-for": address, "user-agent": AGENT, origin: ORIGIN });
}

async function requestLink(email: string, address?: string): Promise<Response> {
  const response = await POST(
    new Request(`${ORIGIN}/api/auth/sign-in/magic-link`, { method: "POST", headers: headers(address), body: JSON.stringify({ email }) }),
  );
  await settleAuthBackgroundTasks();
  return response;
}

async function tokenFromMail(index = 0): Promise<string> {
  const message = (await systemMailMessages())[index]!;
  const body = await readBody(Buffer.from(message.bodyKey ?? "", "base64"), message.storageKey ?? "");
  const link = body.text?.match(/https?:\/\/\S+/)?.[0];
  const url = new URL(link!);
  expect(url.pathname).toBe("/login/link");
  return url.searchParams.get("token")!;
}

/** What the confirm page's server action does. */
function verify(token: string) {
  return auth.api.magicLinkVerify({ query: { token }, headers: headers() });
}

async function signedInRows() {
  return db.select().from(activity).where(and(eq(activity.organizationId, organizationId), eq(activity.action, "session.signed_in")));
}

beforeEach(async () => {
  await resetDatabase();
  await db.delete(verifications);
  resetRateLimitMemory();
  const fixture = await seedFixture();
  organizationId = fixture.organizationId;
  await seedSystemOrganization();

  const ctx = await auth.$context;
  const created = await ctx.internalAdapter.createUser({ email: EMAIL, name: "Owner", organizationId, emailVerified: true }, { method: "admin" });
  userId = created.id;
});

describe("POST /api/auth/sign-in/magic-link", () => {
  it("emails a link to a known address and records the request", async () => {
    const response = await requestLink(EMAIL);

    expect(response.status).toBe(200);
    const sent = await systemMailMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.recipients).toEqual([EMAIL]);
    expect(await tokenFromMail()).toBeTruthy();

    const [row] = await db.select().from(activity).where(eq(activity.action, "session.magic_link.requested"));
    expect(row!.organizationId).toBe(organizationId);
    expect(row!.actorId).toBe(userId);
    expect(row!.ipHash).toBe(hashIp(IP));
    expect(row!.userAgent).toBe(AGENT);
  });

  it("answers an unknown address like a known one, sends nothing and creates nothing", async () => {
    const known = await requestLink(EMAIL, "203.0.113.11");
    const unknown = await requestLink("nobody@example.net", "203.0.113.12");

    expect(unknown.status).toBe(known.status);
    expect(await unknown.json()).toEqual(await known.json());
    expect(await systemMailMessages()).toHaveLength(1);
    expect(await db.select().from(verifications)).toHaveLength(1);
    expect(await db.select().from(users).where(eq(users.email, "nobody@example.net"))).toHaveLength(0);
  });

  it("sends nothing for an unknown address even when the guard is skipped", async () => {
    await auth.api.signInMagicLink({ body: { email: "nobody@example.net" }, headers: headers() });
    await settleAuthBackgroundTasks();

    expect(await systemMailMessages()).toHaveLength(0);
  });

  it("stores the token hashed and keeps it for ten minutes", async () => {
    await requestLink(EMAIL);
    const token = await tokenFromMail();

    const [row] = await db.select().from(verifications);
    expect(row!.identifier).not.toContain(token);
    expect(row!.identifier).toBe(createHash("sha256").update(token).digest("base64url"));
    const ttlMs = row!.expiresAt.getTime() - row!.createdAt.getTime();
    expect(Math.abs(ttlMs - 10 * 60 * 1000)).toBeLessThan(5000);
  });

  it("answers 503 for every address while system mail isn't set up", async () => {
    await resetDatabase();
    await seedFixture();

    for (const email of [EMAIL, "nobody@example.net"]) {
      const response = await requestLink(email);
      expect(response.status).toBe(503);
      expect(((await response.json()) as { message: string }).message).toContain("system from address");
    }
  });

  it("limits requests from one client address", async () => {
    process.env.MAGIC_LINK_RATE_LIMIT = "2";
    try {
      await requestLink("a@example.net");
      await requestLink("b@example.net");
      const limited = await requestLink("c@example.net");

      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBeTruthy();
      expect((await requestLink("d@example.net", "203.0.113.99")).status).toBe(200);
    } finally {
      delete process.env.MAGIC_LINK_RATE_LIMIT;
    }
  });

  it("limits requests for one email address across client addresses, known or not", async () => {
    for (let i = 0; i < 3; i++) expect((await requestLink(EMAIL, `198.51.100.${i}`)).status).toBe(200);
    const limited = await requestLink(EMAIL, "198.51.100.50");

    expect(limited.status).toBe(429);
    expect(await systemMailMessages()).toHaveLength(3);

    for (let i = 0; i < 3; i++) expect((await requestLink("nobody@example.net", `192.0.2.${i}`)).status).toBe(200);
    expect((await requestLink("nobody@example.net", "192.0.2.50")).status).toBe(429);
  });
});

describe("magic link verification", () => {
  it("signs in once, records it, and refuses the same link again", async () => {
    await requestLink(EMAIL);
    const token = await tokenFromMail();

    const first = await verify(token);
    expect(first.user.id).toBe(userId);
    expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(1);

    await expect(verify(token)).rejects.toMatchObject({ status: "FOUND" });
    expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(1);
  });

  it("records session.signed_in with the hashed address and user agent", async () => {
    await requestLink(EMAIL);
    await verify(await tokenFromMail());

    const rows = await signedInRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorId).toBe(userId);
    expect(rows[0]!.ipHash).toBe(hashIp(IP));
    expect(rows[0]!.userAgent).toBe(AGENT);
    expect(rows[0]!.metadata).toEqual({ method: "magic_link" });
  });

  it("records a sign-in through Better Auth's own verify URL too, and still works once", async () => {
    await requestLink(EMAIL);
    const token = await tokenFromMail();
    const url = `${ORIGIN}/api/auth/magic-link/verify?token=${token}&callbackURL=%2F`;

    const first = await GET(new Request(url, { headers: headers() }));
    expect(first.status).toBe(302);
    expect(first.headers.get("set-cookie")).toContain("session_token");
    const second = await GET(new Request(url, { headers: headers() }));
    expect(second.headers.get("set-cookie") ?? "").not.toContain("session_token");

    expect(await signedInRows()).toHaveLength(1);
  });

  it("refuses an expired link and starts no session", async () => {
    await requestLink(EMAIL);
    const token = await tokenFromMail();
    await db.update(verifications).set({ expiresAt: new Date(Date.now() - 1000) });

    await expect(verify(token)).rejects.toMatchObject({ status: "FOUND" });
    expect(await db.select().from(sessions)).toHaveLength(0);
    expect(await signedInRows()).toHaveLength(0);
  });

  it("refuses a token nobody issued", async () => {
    await expect(verify(randomBytes(16).toString("hex"))).rejects.toMatchObject({ status: "FOUND" });
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it("never creates an account, even for a valid token issued for an unknown address", async () => {
    const token = randomBytes(16).toString("hex");
    await db.insert(verifications).values({
      id: "ver_unknown",
      identifier: createHash("sha256").update(token).digest("base64url"),
      value: JSON.stringify({ email: "nobody@example.net" }),
      expiresAt: new Date(Date.now() + 60_000),
    });

    // The plugin's own refusal, not the organization column failing the insert.
    const location = await verify(token).then(
      () => null,
      (error: { headers: Headers }) => error.headers.get("location"),
    );
    expect(location).toContain("error=new_user_signup_disabled");
    expect(await db.select().from(users).where(eq(users.email, "nobody@example.net"))).toHaveLength(0);
    expect(await db.select().from(sessions)).toHaveLength(0);
  });
});

describe("passkey sign-in", () => {
  it("offers discoverable options to a visitor with no session, and sets a signed challenge", async () => {
    const response = await GET(new Request(`${ORIGIN}/api/auth/passkey/generate-authenticate-options`, { headers: headers() }));

    expect(response.status).toBe(200);
    const options = (await response.json()) as { challenge: string; rpId: string; allowCredentials?: unknown[] };
    expect(options.challenge).toBeTruthy();
    expect(options.allowCredentials ?? []).toHaveLength(0);
    expect(response.headers.get("set-cookie")).toContain("better-auth-passkey");
  });

  it("refuses an assertion with no challenge and starts no session", async () => {
    const response = await POST(
      new Request(`${ORIGIN}/api/auth/passkey/verify-authentication`, { method: "POST", headers: headers(), body: JSON.stringify({ response: { id: "x" } }) }),
    );

    expect(response.status).toBe(400);
    expect(await db.select().from(sessions)).toHaveLength(0);
    expect(await signedInRows()).toHaveLength(0);
  });

  it("signs in with a valid assertion and records it with the hashed address and user agent", async () => {
    const authenticator = await registerAuthenticator();
    const { status, cookie } = await assertWith(authenticator);

    expect(status).toBe(200);
    expect(cookie).toContain("session_token");
    expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(1);
    const rows = await signedInRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorId).toBe(userId);
    expect(rows[0]!.ipHash).toBe(hashIp(IP));
    expect(rows[0]!.userAgent).toBe(AGENT);
    expect(rows[0]!.metadata).toEqual({ method: "passkey" });
  });

  it("asks the browser to verify the user", async () => {
    const response = await GET(new Request(`${ORIGIN}/api/auth/passkey/generate-authenticate-options`, { headers: headers() }));

    expect(((await response.json()) as { userVerification: string }).userVerification).toBe("required");
    expect(response.headers.get("set-cookie")).toContain("better-auth-passkey");
  });

  it("asks for user verification when a passkey is registered", async () => {
    const options = await (await auth.$context).options.plugins?.find((plugin) => plugin.id === "passkey");
    expect((options as { options?: { authenticatorSelection?: { userVerification?: string } } }).options?.authenticatorSelection?.userVerification).toBe("required");
  });

  it("refuses a valid signature when the authenticator didn't verify the user", async () => {
    const authenticator = await registerAuthenticator();
    const { status, cookie } = await assertWith(authenticator, 0x01);

    expect(status).toBe(400);
    expect(cookie).not.toContain("session_token");
    expect(await db.select().from(sessions)).toHaveLength(0);
    expect(await signedInRows()).toHaveLength(0);
  });

  it("refuses a bad signature and records nothing", async () => {
    const authenticator = await registerAuthenticator();
    const { status } = await assertWith({ ...authenticator, privateKey: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey });

    expect(status).not.toBe(200);
    expect(await db.select().from(sessions)).toHaveLength(0);
    expect(await signedInRows()).toHaveLength(0);
  });
});

interface Authenticator {
  credentialId: string;
  privateKey: KeyObject;
}

/** A software authenticator: a P-256 key the passkey table knows, standing in for a device. */
async function registerAuthenticator(): Promise<Authenticator> {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x!, "base64url");
  const y = Buffer.from(jwk.y!, "base64url");
  // COSE_Key, EC2 / ES256 / P-256, as CBOR.
  const cose = Buffer.concat([Buffer.from("a5010203262001215820", "hex"), x, Buffer.from("225820", "hex"), y]);
  const credentialId = randomBytes(16).toString("base64url");
  await db.insert(passkeys).values({
    id: `pk_${credentialId}`,
    userId,
    name: "Test key",
    publicKey: cose.toString("base64"),
    credentialID: credentialId,
    counter: 0,
    deviceType: "multiDevice",
    backedUp: true,
  });
  return { credentialId, privateKey };
}

async function assertWith({ credentialId, privateKey }: Authenticator, flags = 0x05): Promise<{ status: number; cookie: string }> {
  const optionsResponse = await GET(new Request(`${ORIGIN}/api/auth/passkey/generate-authenticate-options`, { headers: headers() }));
  const { challenge, rpId } = (await optionsResponse.json()) as { challenge: string; rpId: string };
  const challengeCookie = (optionsResponse.headers.get("set-cookie") ?? "").split(";")[0]!;

  const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN, crossOrigin: false }));
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(1);
  // Flags: 0x01 user present, 0x04 user verified.
  const authenticatorData = Buffer.concat([createHash("sha256").update(rpId).digest(), Buffer.from([flags]), counter]);
  const signature = createSign("SHA256")
    .update(Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]))
    .sign(privateKey);

  const request = new Request(`${ORIGIN}/api/auth/passkey/verify-authentication`, {
    method: "POST",
    headers: (() => {
      const h = headers();
      h.set("cookie", challengeCookie);
      return h;
    })(),
    body: JSON.stringify({
      response: {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        response: {
          authenticatorData: authenticatorData.toString("base64url"),
          clientDataJSON: clientDataJSON.toString("base64url"),
          signature: signature.toString("base64url"),
        },
      },
    }),
  });
  const response = await POST(request);
  await settleAuthBackgroundTasks();
  return { status: response.status, cookie: response.headers.get("set-cookie") ?? "" };
}

describe("removing a passkey through Better Auth's own endpoint", () => {
  async function removeThrough(cookie: string, id: string): Promise<Response> {
    const h = headers();
    h.set("cookie", cookie.split(";")[0]!);
    return POST(new Request(`${ORIGIN}/api/auth/passkey/delete-passkey`, { method: "POST", headers: h, body: JSON.stringify({ id }) }));
  }

  it("refuses the last credential on an account with no password", async () => {
    const authenticator = await registerAuthenticator();
    const { cookie } = await assertWith(authenticator);

    const response = await removeThrough(cookie, `pk_${authenticator.credentialId}`);

    expect(response.status).toBe(400);
    expect(await db.select().from(passkeys).where(eq(passkeys.userId, userId))).toHaveLength(1);
  });

  it("allows it once the account has a password", async () => {
    const authenticator = await registerAuthenticator();
    const { cookie } = await assertWith(authenticator);
    const ctx = await auth.$context;
    await ctx.internalAdapter.linkAccount({ userId, providerId: "credential", accountId: userId, password: await ctx.password.hash("a long enough passphrase") });

    const response = await removeThrough(cookie, `pk_${authenticator.credentialId}`);

    expect(response.status).toBe(200);
    expect(await db.select().from(passkeys).where(eq(passkeys.userId, userId))).toHaveLength(0);
  });
});
