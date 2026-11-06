"use client";

import { keepValues } from "../../../_ui/keep-values";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, fieldClasses } from "@/components/ui/field";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import type { OperatorOrganizationView, SharedProviderOption } from "@/lib/dashboard/admin-organizations";
import type { AddressLimits } from "@/lib/addresses/limits";
import { formatNumber } from "@/lib/format/number";
import { holdsQueue } from "@/lib/suspension/sources";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useOpenerFocus } from "@/hooks/use-opener-focus";
import { switchOrganizationAction } from "../../../switch-organization-action";
import { RowActions } from "../../../_ui/row-actions";
import { SectionHeader } from "../../../_ui/section-header";
import { useAction } from "../../../_ui/use-action";
import { Time } from "../../../_ui/time";
import {
  assignProviderAction,
  startEmulationAction,
  createOrganizationAdminAction,
  deleteOrganizationAdminAction,
  releaseOrganizationAction,
  setAddressLimitsAction,
  suspendOrganizationAction,
  type CreateOrganizationState,
} from "./actions";

const SOURCE_LABEL = { manual: "by an admin", reputation: "by the reputation guard", provider: "by the provider" } as const;

type Pending = { kind: "suspend" | "release" | "assign" | "delete" | "emulate" | "limits"; organization: OperatorOrganizationView };

export function OrganizationsScreen({
  organizations,
  sharedProviders,
  defaultProvider,
  addressLimitDefaults,
  memberOf,
  focus,
}: {
  organizations: OperatorOrganizationView[];
  sharedProviders: SharedProviderOption[];
  defaultProvider: SharedProviderOption | null;
  /** The install's address limits, for an organization without its own. */
  addressLimitDefaults: AddressLimits;
  /** Ids the admin belongs to. Those are switched into, never emulated. */
  memberOf: string[];
  /** From a link: the organization to show, and where to land once inside it. */
  focus: { organizationId: string; next: string | null } | null;
}) {
  const suspend = useAction(suspendOrganizationAction);
  const release = useAction(releaseOrganizationAction);
  const assign = useAction(assignProviderAction);
  const remove = useAction(deleteOrganizationAdminAction);
  const limits = useAction(setAddressLimitsAction);
  // Only failures land here: a started emulation redirects into the organization.
  const emulate = useAction(startEmulationAction, (result) => {
    if (result.status === "error") toast({ title: result.message, variant: "error" });
  });
  const focused = focus ? organizations.find((org) => org.id === focus.organizationId) : undefined;
  const [pending, setPending] = useState<Pending | null>(() =>
    focused && focus?.next && !memberOf.includes(focused.id) ? { kind: "emulate", organization: focused } : null,
  );
  const [creating, setCreating] = useState(false);
  const [reason, setReason] = useState("");
  const [activeLimit, setActiveLimit] = useState("");
  const [dailyLimit, setDailyLimit] = useState("");
  const [sharedProviderId, setSharedProviderId] = useState(defaultProvider?.id ?? sharedProviders[0]?.id ?? "");
  const opener = useOpenerFocus();
  const router = useRouter();
  const landing = useRef(focus?.next ?? null);

  useEffect(() => {
    if (!focus) return;
    if (!focused) {
      toast({ title: "That organization no longer exists.", variant: "error" });
      return;
    }
    document.getElementById(`organization-${focused.id}`)?.scrollIntoView({ block: "center" });
    const next = focus.next;
    if (next && memberOf.includes(focused.id)) {
      void switchOrganizationAction(focused.id).then((result) => (result.ok ? router.push(next) : undefined));
    }
    // Runs once per link followed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const suspendedCount = organizations.filter((org) => org.suspension).length;
  const unassignedCount = organizations.filter((org) => !org.provider).length;

  function open(event: React.MouseEvent<HTMLElement>, next: Pending) {
    opener.remember(event);
    setReason("");
    setActiveLimit(next.organization.addressLimits.activeOverride?.toString() ?? "");
    setDailyLimit(next.organization.addressLimits.dailyOverride?.toString() ?? "");
    setPending(next);
  }

  function confirm() {
    if (!pending) return;
    const form = new FormData();
    form.set("id", pending.organization.id);
    if (pending.kind === "suspend") {
      form.set("reason", reason);
      suspend.formAction(form);
    } else if (pending.kind === "release") {
      release.formAction(form);
    } else if (pending.kind === "delete") {
      remove.formAction(form);
    } else if (pending.kind === "limits") {
      form.set("addressLimit", activeLimit);
      form.set("addressDailyMessageLimit", dailyLimit);
      limits.formAction(form);
    } else if (pending.kind === "emulate") {
      if (landing.current) form.set("next", landing.current);
      emulate.formAction(form);
    } else {
      form.set("sharedProviderId", sharedProviderId);
      assign.formAction(form);
    }
    setPending(null);
  }

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader
        title="Organizations"
        description="A suspended organization can't send. An admin's suspension fails queued mail. A reputation or provider suspension holds it until release."
        meta={[
          `${organizations.length} ${organizations.length === 1 ? "organization" : "organizations"}`,
          suspendedCount > 0 ? `${suspendedCount} suspended` : null,
          unassignedCount > 0 ? `${unassignedCount} without a provider` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <Button size="md" onClick={() => setCreating(true)}>
            New organization
          </Button>
        }
      />

      <Card className="overflow-hidden p-0">
        <ul>
          {organizations.map((org) => (
            <li
              key={org.id}
              id={`organization-${org.id}`}
              className={cn(
                "group/row grid gap-3 border-b border-border p-5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_minmax(0,22rem)] sm:items-center sm:gap-x-6",
                focus?.organizationId === org.id && "bg-accent",
              )}
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-semibold text-foreground">
                  <span className="min-w-0 break-words">{org.name}</span>
                  {org.suspension ? <Chip tone="issue">suspended</Chip> : null}
                </p>
                <p className="type-body-sm break-all font-mono text-muted-foreground">
                  {org.slug} · {org.domainCount} {org.domainCount === 1 ? "domain" : "domains"}
                </p>
                {org.addressLimits.activeOverride !== null || org.addressLimits.dailyOverride !== null ? (
                  <p className="type-body-sm text-muted-foreground">
                    Its own address limits: {formatNumber(org.addressLimits.active)} active, {formatNumber(org.addressLimits.daily)} messages per address a day
                  </p>
                ) : null}
                {org.suspension ? (
                  <p className="type-body-sm mt-1 max-w-2xl text-foreground-soft">
                    Suspended {SOURCE_LABEL[org.suspension.source]} <Time date={org.suspension.suspendedAt} />. {org.suspension.reason}
                  </p>
                ) : null}
              </div>
              <div className="min-w-0">
                <p className="type-label text-muted-foreground sm:sr-only">Provider</p>
                {org.provider ? (
                  <p className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/admin/settings/providers/${org.provider.managedProviderId}`}
                      className={cn("type-body-sm min-w-0 break-words font-semibold text-foreground hover:underline", FOCUS_RING)}
                    >
                      {org.provider.name}
                    </Link>
                    {org.provider.settingUp ? <Chip tone="warn">Setting up</Chip> : null}
                  </p>
                ) : (
                  <Chip tone="issue" caps={false}>
                    Can&apos;t send: no provider
                  </Chip>
                )}
              </div>
              <div className="flex items-center gap-2 sm:justify-end">
                {!org.provider && sharedProviders.length > 0 ? (
                  <Button type="button" variant="secondary" size="sm" onClick={(event) => open(event, { kind: "assign", organization: org })}>
                    Assign provider
                  </Button>
                ) : org.suspension ? (
                  <Button type="button" variant="secondary" size="sm" onClick={(event) => open(event, { kind: "release", organization: org })}>
                    Release
                  </Button>
                ) : null}
                <RowActions
                  label={`Actions for ${org.name}`}
                  actions={[
                    !memberOf.includes(org.id) && { label: "Emulate", onSelect: (event) => open(event, { kind: "emulate", organization: org }) },
                    { label: "Address limits", onSelect: (event) => open(event, { kind: "limits", organization: org }) },
                    org.suspension
                      ? !org.provider && sharedProviders.length > 0 && { label: "Release", onSelect: (event) => open(event, { kind: "release", organization: org }) }
                      : { label: "Suspend", onSelect: (event) => open(event, { kind: "suspend", organization: org }) },
                    { label: "Delete", destructive: true, onSelect: (event) => open(event, { kind: "delete", organization: org }) },
                  ]}
                />
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <ConfirmDialog
        open={pending?.kind === "suspend"}
        onOpenChange={(isOpen) => !isOpen && setPending(null)}
        onCloseAutoFocus={opener.restore}
        title={pending ? `Suspend ${pending.organization.name}?` : ""}
        consequence="Its sends are refused immediately and every queued message fails with your reason. Nothing sends again until an admin releases it."
        confirmLabel="Suspend"
        tone="destructive"
        loading={suspend.pending}
        onConfirm={confirm}
      >
        <Field id="suspend-reason" label="Reason" hint="Shown to the organization and returned with every refused send." className="mt-3">
          <textarea
            id="suspend-reason"
            name="reason"
            rows={3}
            required
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className={`${fieldClasses({ shape: "compact", size: "md" })} w-full`}
            placeholder="Complaints from recipients about unsolicited mail."
          />
        </Field>
      </ConfirmDialog>

      <ConfirmDialog
        open={pending?.kind === "limits"}
        onOpenChange={(isOpen) => !isOpen && setPending(null)}
        onCloseAutoFocus={opener.restore}
        title={pending ? `Address limits for ${pending.organization.name}` : ""}
        consequence="Lowering either leaves existing addresses alone. New addresses past the limit are refused, and mail past the daily limit is dropped."
        confirmLabel="Save"
        loading={limits.pending}
        onConfirm={confirm}
      >
        <div className="mt-3 flex flex-col gap-3">
          <Field id="limits-active" label="Active addresses" hint={`Blank follows the install's default, ${formatNumber(addressLimitDefaults.active)}.`}>
            <input
              id="limits-active"
              name="addressLimit"
              type="number"
              min={0}
              max={1_000_000}
              value={activeLimit}
              onChange={(event) => setActiveLimit(event.target.value)}
              placeholder={String(addressLimitDefaults.active)}
              className={inputClass}
            />
          </Field>
          <Field
            id="limits-daily"
            label="Messages per address a day"
            hint={`Blank follows the install's default, ${formatNumber(addressLimitDefaults.daily)}.`}
          >
            <input
              id="limits-daily"
              name="addressDailyMessageLimit"
              type="number"
              min={0}
              max={1_000_000}
              value={dailyLimit}
              onChange={(event) => setDailyLimit(event.target.value)}
              placeholder={String(addressLimitDefaults.daily)}
              className={inputClass}
            />
          </Field>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={pending?.kind === "release"}
        onOpenChange={(isOpen) => !isOpen && setPending(null)}
        onCloseAutoFocus={opener.restore}
        title={pending ? `Release ${pending.organization.name}?` : ""}
        consequence={
          pending?.organization.suspension && holdsQueue(pending.organization.suspension.source)
            ? "It sends again immediately, including the messages held since the suspension."
            : "It sends again immediately. Messages that failed during the suspension stay failed."
        }
        confirmLabel="Release"
        loading={release.pending}
        onConfirm={confirm}
      />
      <ConfirmDialog
        open={pending?.kind === "assign"}
        onOpenChange={(isOpen) => !isOpen && setPending(null)}
        onCloseAutoFocus={opener.restore}
        title={pending ? `Assign a provider to ${pending.organization.name}?` : ""}
        consequence="Its domains send through this provider, isolated from every other organization. Nothing is created at AWS until it adds its first domain."
        confirmLabel="Assign"
        loading={assign.pending}
        onConfirm={confirm}
      >
        <Field id="assign-provider" label="Provider" className="mt-3">
          <Select
            id="assign-provider"
            items={sharedProviders.map((provider) => ({ value: provider.id, label: provider.name }))}
            value={sharedProviderId}
            onValueChange={setSharedProviderId}
            size="md"
            shape="compact"
          />
        </Field>
      </ConfirmDialog>

      <ConfirmDialog
        open={pending?.kind === "delete"}
        onOpenChange={(isOpen) => !isOpen && setPending(null)}
        onCloseAutoFocus={opener.restore}
        title={pending ? `Delete ${pending.organization.name}?` : ""}
        consequence={
          pending ? deleteConsequence(pending.organization.domainCount) : ""
        }
        confirmLabel="Delete organization"
        tone="destructive"
        loading={remove.pending}
        onConfirm={confirm}
      >
        <p className="type-body-sm text-muted-foreground">
          Accounts and their other organizations stay. The shared provider and the organizations on it are untouched.
          It&apos;s refused while mail is queued, until the queue drains or you suspend it.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={pending?.kind === "emulate"}
        onOpenChange={(isOpen) => !isOpen && setPending(null)}
        onCloseAutoFocus={opener.restore}
        title={pending ? `Emulate ${pending.organization.name}?` : ""}
        consequence="You see their dashboard as an owner, and your changes are real. Entering, leaving and every write are recorded as yours in their activity."
        confirmLabel="Emulate"
        loading={emulate.pending}
        onConfirm={confirm}
      >
        <p className="type-body-sm text-muted-foreground">
          A banner on every screen names the organization and has the way out. Emulation ends after 30 minutes.
        </p>
      </ConfirmDialog>

      {creating ? <NewOrganizationDialog defaultProvider={defaultProvider} onClose={() => setCreating(false)} /> : null}
    </section>
  );
}

function deleteConsequence(domains: number): string {
  const rest = "messages, events, keys, lists, suppressions and memberships go with";
  if (domains === 0) return `It has no domains. Its ${rest} it.`;
  return `Its ${domains} ${domains === 1 ? "domain comes" : "domains come"} off the provider and stop sending immediately. Its ${rest} them.`;
}

const inputClass = `${fieldClasses({ shape: "compact", size: "md" })} w-full`;

function NewOrganizationDialog({ defaultProvider, onClose }: { defaultProvider: SharedProviderOption | null; onClose: () => void }) {
  const { state, formAction, pending } = useAction<CreateOrganizationState>(createOrganizationAdminAction, (result) => {
    if (result.status === "created") toast({ title: `${result.name} created.`, variant: "success" });
    // A field error is already on the field it names.
    if (result.status === "error" && !result.field) toast({ title: result.message, variant: "error" });
  });

  if (state.status === "created") {
    return (
      <Modal open onOpenChange={(isOpen) => !isOpen && onClose()} title={`${state.name} created`}>
        <div className="flex flex-col gap-4">
          <p className="type-body text-foreground-soft">
            {state.providerName
              ? `It sends through ${state.providerName}. You're its owner.`
              : "It can't send until an admin assigns it a provider. You're its owner."}
          </p>
          <div className="flex justify-end">
            <Button size="md" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  const error = state.status === "error" ? state : null;

  return (
    <Modal
      open
      onOpenChange={(isOpen) => !isOpen && onClose()}
      title="New organization"
      description={
        defaultProvider
          ? `It gets ${defaultProvider.name}, the default for new organizations. You're added as its owner.`
          : "No provider is marked the default, so it can't send until you assign one. You're added as its owner."
      }
    >
      <form onSubmit={keepValues(formAction)} className="flex flex-col gap-4">
        <Field id="new-org-name" label="Name" error={error?.field === "name" ? error.message : undefined}>
          <input id="new-org-name" name="name" required maxLength={100} autoComplete="off" className={inputClass} />
        </Field>
        <Field
          id="new-org-slug"
          label="Slug"
          hint="Lowercase letters, numbers and hyphens. Blank derives one from the name."
          error={error?.field === "slug" ? error.message : undefined}
        >
          <input id="new-org-slug" name="slug" maxLength={100} autoComplete="off" className={`${inputClass} font-mono`} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="md" loading={pending}>
            Create organization
          </Button>
        </div>
      </form>
    </Modal>
  );
}
