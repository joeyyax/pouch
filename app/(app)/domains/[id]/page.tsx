import { DomainPage } from "./domain-page";

export const dynamic = "force-dynamic";

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return <DomainPage params={params} section={null} />;
}
