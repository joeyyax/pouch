"use client";
import { createOpenAPIPage } from "fumadocs-openapi/ui";
import type { Document } from "fumadocs-openapi";

// One chunk the browser caches, rather than the whole document in every page's props.
export const OpenAPIPage = createOpenAPIPage({
  loadDocument: async () => (await import("@/openapi.json")).default as unknown as Document,
});
