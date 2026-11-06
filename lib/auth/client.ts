"use client";

import { createAuthClient } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";

export const authClient = createAuthClient({
  ...(process.env.NEXT_PUBLIC_APP_URL ? { baseURL: process.env.NEXT_PUBLIC_APP_URL } : {}),
  plugins: [passkeyClient(), magicLinkClient()],
});

export const { signIn, signOut, useSession } = authClient;
