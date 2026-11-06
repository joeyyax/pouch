/**
 * Signs in an account an invitation just created without a password, when password sign-in is
 * off. The redeemed invitation is the credential. Server-only: the router doesn't serve it, so
 * only `redeemInvitation`'s caller reaches it through `auth.api`.
 */
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { BetterAuthPlugin } from "better-auth";
import { z } from "zod";

export function invitationSessions() {
  return {
    id: "invitation-session",
    endpoints: {
      signInInvitedAccount: createAuthEndpoint(
        "/invitation/sign-in",
        { method: "POST", body: z.object({ userId: z.string().min(1) }), metadata: { SERVER_ONLY: true } },
        async (ctx) => {
          const user = await ctx.context.internalAdapter.findUserById(ctx.body.userId);
          if (!user) throw new APIError("NOT_FOUND", { message: "No account for that invitation." });
          const session = await ctx.context.internalAdapter.createSession(user.id);
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ userId: user.id });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
