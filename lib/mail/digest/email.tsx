import { SystemMail } from "@/lib/mail/template";
import { digestMail } from "./copy";
import type { DigestSummary } from "./metrics";

export function DigestEmail({ summary, unsubscribeUrl }: { summary: DigestSummary; unsubscribeUrl: string }) {
  return <SystemMail {...digestMail(summary, unsubscribeUrl)} />;
}
