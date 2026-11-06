import { llmsIndex } from "@/lib/api-docs/llms";
import { baseUrl } from "@/lib/api/urls";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(llmsIndex(baseUrl()), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}
