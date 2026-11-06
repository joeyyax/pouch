"use client";

import Link from "next/link";
import { Card } from "@/components/ui/card";
import type { InProgressTestMessage } from "@/lib/dashboard/domains";
import type { DomainDetailData, DomainKeys } from "@/lib/dashboard/views/domains";
import { cn } from "@/lib/utils";
import { CopyOnHover } from "../_ui/copy-on-hover";
import { INACTIVE_ROW } from "../_ui/inactive";
import { SectionHeader } from "../_ui/section-header";
import type { SnippetLanguage } from "@/lib/dashboard/curl";
import { Snippet } from "../_ui/snippet";
import { KeyChip } from "../_ui/status";
import { BulkCard } from "./bulk-card";
import { LayoutCard } from "./layout-card";
import { TestEmailCard } from "./test-email-card";

/** A test send, the keys that send from here, the layout and bulk. */
export function SendingSection({
  domain,
  keys,
  defaultTo,
  inProgressTest,
  sendSnippets,
  bulk,
  canManage,
}: {
  domain: DomainDetailData;
  keys: DomainKeys;
  defaultTo: string;
  inProgressTest: InProgressTestMessage | null;
  /** A send from this domain, with a placeholder key. Null until the domain is verified. */
  sendSnippets: SnippetLanguage[] | null;
  /** Whether the bulk feature is on. */
  bulk: boolean;
  canManage: boolean;
}) {
  const verified = domain.status === "verified";
  const live = keys.keys.filter((key) => !key.revoked).length;

  return (
    <div className="flex flex-col gap-6">
      {verified ? (
        <TestEmailCard
          domainId={domain.id}
          domainName={domain.name}
          defaultTo={defaultTo}
          hasLayout={domain.layout !== null}
          inProgressTest={inProgressTest}
        />
      ) : null}

      <Card className="flex flex-col gap-3 p-5">
        <SectionHeader
          title="Keys that send from here"
          meta={
            verified
              ? `${live} scoped here${keys.unscopedKeys > 0 ? `, and ${keys.unscopedKeys} scoped to no domain` : ""}.`
              : `Sends from ${domain.name} fail at the API until it verifies.`
          }
          actions={
            <Link href="/keys" className="type-body-sm text-primary-strong underline underline-offset-4">
              All keys
            </Link>
          }
        />
        {keys.keys.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border">
            {keys.keys.map((key) => (
              <li key={key.id} className={cn("flex items-center justify-between gap-3 py-2.5", key.revoked && INACTIVE_ROW)}>
                <CopyOnHover value={key.name} label="key name" className="font-mono text-sm" hideOnTouch>
                  <Link href={`/keys/${key.id}`} className="text-foreground underline underline-offset-4 hover:no-underline">
                    {key.name}
                  </Link>
                </CopyOnHover>
                <KeyChip mode={key.mode} revoked={key.revoked} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="type-body-sm text-muted-foreground">
            No key is scoped to this domain.
            {keys.unscopedKeys > 0
              ? ` ${keys.unscopedKeys} ${keys.unscopedKeys === 1 ? "key is" : "keys are"} scoped to no domain and can send from here.`
              : null}
          </p>
        )}
        {sendSnippets ? (
          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <p className="type-body-sm text-muted-foreground">Any of them can send this.</p>
            <Snippet languages={sendSnippets} />
          </div>
        ) : null}
      </Card>

      <LayoutCard domainId={domain.id} domainName={domain.name} layout={domain.layout} canManage={canManage} />

      {bulk ? (
        <BulkCard domainId={domain.id} bulkAllowed={domain.bulkAllowed} bulkCapable={domain.bulkCapable} canManage={canManage} />
      ) : null}
    </div>
  );
}
