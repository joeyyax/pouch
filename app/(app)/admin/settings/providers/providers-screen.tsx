"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { Icon } from "@/components/ui/icon";
import type { AdminProviderListItem, AdminProviderOrganization, AdminAdapterOption } from "@/lib/dashboard/admin-providers";
import { cn } from "@/lib/utils";
import { SectionHeader } from "../../../_ui/section-header";
import { AddProviderDialog } from "./_ui/add-provider-dialog";
import { IssueChips } from "./_ui/issue-chips";

export function ProvidersScreen({
  providers,
  adapters,
  organizations,
}: {
  providers: AdminProviderListItem[];
  adapters: AdminAdapterOption[];
  organizations: AdminProviderOrganization[];
}) {
  const [adding, setAdding] = useState(false);
  const needing = providers.filter((provider) => provider.issues.length > 0).length;

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader
        title="Providers"
        description="Each organization sends through one provider. An account-level pause from AWS stops every organization on it."
        meta={`${providers.length} ${providers.length === 1 ? "provider" : "providers"}${needing > 0 ? ` · ${needing} need attention` : ""}`}
        actions={
          <Button size="md" onClick={() => setAdding(true)}>
            Add provider
          </Button>
        }
      />

      <Card className="overflow-hidden p-0">
        {providers.length === 0 ? (
          <EmptyState
            icon="key"
            title="No providers"
            description="Add one, then mark it the default so new organizations can send."
          />
        ) : (
          <ul>
            {providers.map((provider) => (
              <li key={provider.id} className="border-b border-border last:border-b-0">
                <Link
                  href={`/admin/settings/providers/${provider.id}`}
                  className={cn("flex items-center gap-3 p-5 transition-colors hover:bg-muted/50", FOCUS_RING)}
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-semibold text-foreground">
                      <span className="min-w-0 break-words">{provider.name}</span>
                      {provider.isDefault ? <Chip>Default for new organizations</Chip> : null}
                      <IssueChips issues={provider.issues} />
                    </p>
                    <p className="type-body-sm mt-0.5 break-words text-muted-foreground">
                      {provider.adapterLabel} · {servesLabel(provider)}
                    </p>
                  </div>
                  <Icon name="chevron" className="size-4 shrink-0 -rotate-90 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {adding ? <AddProviderDialog adapters={adapters} organizations={organizations} onClose={() => setAdding(false)} /> : null}
    </section>
  );
}

function servesLabel(provider: AdminProviderListItem): string {
  if (provider.kind !== "shared") return provider.organization ? `Serves ${provider.organization.name}` : "No organization";
  return `Serves ${provider.organizationCount} ${provider.organizationCount === 1 ? "organization" : "organizations"}`;
}
