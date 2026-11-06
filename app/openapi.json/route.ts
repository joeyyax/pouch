import { openApiDocument } from "@/lib/api-docs/openapi";
import { baseUrl } from "@/lib/api/urls";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(openApiDocument(baseUrl()), {
    headers: { "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" },
  });
}
