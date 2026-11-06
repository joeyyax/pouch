import { listServiceMail, listServiceSuppressions } from "@/lib/system/service-mail";
import { ServiceMailScreen } from "./service-mail-screen";

export const dynamic = "force-dynamic";

export default async function ServiceMailPage({ searchParams }: { searchParams: Promise<{ before?: string | string[] }> }) {
  const { before } = await searchParams;
  const cursor = (Array.isArray(before) ? before[0] : before) || null;
  const [page, suppressed] = await Promise.all([listServiceMail(cursor), listServiceSuppressions()]);

  return <ServiceMailScreen rows={page.rows} nextCursor={page.nextCursor} paged={cursor !== null} suppressed={suppressed} />;
}
