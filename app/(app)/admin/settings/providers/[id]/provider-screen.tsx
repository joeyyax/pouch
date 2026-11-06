"use client";

import { keepValues } from "../../../../_ui/keep-values";
import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, fieldClasses } from "@/components/ui/field";
import { KeyValueList } from "@/components/ui/key-value-list";
import { Select } from "@/components/ui/select";
import { TextLink } from "@/components/ui/text-link";
import { useOpenerFocus } from "@/hooks/use-opener-focus";
import { idle } from "@/lib/dashboard/action-state";
import type { AdminProviderDetail, AssignedOrganization } from "@/lib/dashboard/admin-providers";
import { RowActions } from "../../../../_ui/row-actions";
import { SectionHeader } from "../../../../_ui/section-header";
import { useAction } from "../../../../_ui/use-action";
import {
  assignOrganizationAction,
  deleteProviderAction,
  runSetupAction,
  setWebhookKeyAction,
  testProviderAction,
  unassignOrganizationAction,
  type TestProviderState,
} from "../actions";
import { AdoptDomainDialog } from "../_ui/adopt-domain-dialog";
import { IssueChips } from "../_ui/issue-chips";
import { RenameProviderDialog } from "../_ui/rename-provider-dialog";
import { RotateCredentialsDialog } from "../_ui/rotate-credentials-dialog";
import { ConvertDialog } from "./convert-dialog";
import { Time } from "../../../../_ui/time";

type Dialog = "rotate" | "rename" | "convert" | "delete" | "assign" | null;

export function ProviderScreen({ provider }: { provider: AdminProviderDetail }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [unassigning, setUnassigning] = useState<AssignedOrganization | null>(null);
  const [adoptingFor, setAdoptingFor] = useState<AssignedOrganization | null>(null);
  const [assignTo, setAssignTo] = useState(provider.assignable[0]?.id ?? "");
  const opener = useOpenerFocus();
  const shared = provider.kind === "shared";

  const remove = useAction(deleteProviderAction);
  const setup = useAction(runSetupAction);
  const assign = useAction(assignOrganizationAction);
  const unassign = useAction(unassignOrganizationAction);


  function submit(action: (form: FormData) => void, fields: Record<string, string>) {
    const form = new FormData();
    form.set("id", provider.id);
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    action(form);
  }

  const organizationName = provider.organization?.name ?? "The organization";
  const canDelete = shared ? provider.organizations.length === 0 : provider.organizations.every((org) => org.domainCount === 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <TextLink href="/admin/settings/providers" className="type-body-sm w-fit">
          All providers
        </TextLink>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="type-title min-w-0 break-words text-xl text-foreground">{provider.name}</h2>
          {provider.isDefault ? <Chip>Default for new organizations</Chip> : null}
          <IssueChips issues={provider.issues} />
        </div>
        <p className="type-body-sm text-muted-foreground">
          {provider.adapterLabel} · {shared ? "serves every organization, each isolated" : `serves ${organizationName}`}
        </p>
      </div>

      {provider.conversion ? (
        <Callout tone="info" title="Needs conversion">
          <span className="block">
            {organizationName} sends through its own SES setup. Converting moves it onto a shared provider, isolated there,
            with no gap in sending.
          </span>
          {provider.conversion.blocked ? (
            <span className="mt-1 block font-semibold text-foreground">{provider.conversion.blocked}</span>
          ) : (
            <Button
              size="sm"
              className="mt-3"
              onClick={(event) => {
                opener.remember(event);
                setDialog("convert");
              }}
            >
              Convert
            </Button>
          )}
        </Callout>
      ) : null}

      {provider.health.ok === false ? (
        <Callout tone="danger" title="Credentials failing">
          {provider.health.detail ?? "The last check failed."} Rotate them, then test again.
        </Callout>
      ) : null}

      {provider.backoffUntil && provider.issues.includes("backing_off") ? (
        <Callout tone="warn" title="Backing off">
          The provider asked for a pause. Sends resume <Time date={provider.backoffUntil} />.
        </Callout>
      ) : null}

      {provider.issues.includes("quota") ? (
        <Callout tone="warn" title="Quota 80%">
          This provider has used most of its daily send quota. <TextLink href="/admin/settings/system">See Status</TextLink>.
        </Callout>
      ) : null}

      <section className="flex flex-col gap-3">
        <SectionHeader
          title="Organizations"
          meta={`${provider.organizations.length} ${provider.organizations.length === 1 ? "organization" : "organizations"}`}
          actions={
            shared ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={provider.assignable.length === 0}
                onClick={(event) => {
                  opener.remember(event);
                  setDialog("assign");
                }}
              >
                Assign organization
              </Button>
            ) : null
          }
        />
        <Card className="overflow-hidden p-0">
          {provider.organizations.length === 0 ? (
            <p className="type-body-sm p-5 text-muted-foreground">
              No organizations yet. Assign one, or mark this provider the default so new organizations get it.
            </p>
          ) : (
            <ul>
              {provider.organizations.map((org) => (
                <li key={org.id} className="group/row flex items-center justify-between gap-3 border-b border-border p-5 last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-semibold text-foreground">
                      <span className="min-w-0 break-words">{org.name}</span>
                      {org.paused ? <Chip tone="issue">Paused</Chip> : null}
                      {org.settingUp ? <Chip tone="warn">Setting up</Chip> : null}
                    </p>
                    <p className="type-body-sm text-muted-foreground">
                      {org.domainCount} {org.domainCount === 1 ? "domain" : "domains"}
                    </p>
                  </div>
                  <RowActions
                    label={`Actions for ${org.name}`}
                    actions={[
                      provider.canAdopt && {
                        label: "Adopt domain",
                        onSelect: (event) => {
                          opener.remember(event);
                          setAdoptingFor(org);
                        },
                      },
                      shared && {
                        label: "Unassign",
                        onSelect: (event) => {
                          opener.remember(event);
                          setUnassigning(org);
                        },
                      },
                    ]}
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeader title="Credentials" />
        <Card className="flex flex-col gap-4 p-5">
          <CredentialsStatus provider={provider} />
          <div className="flex flex-wrap gap-2">
            <TestButton id={provider.id} />
            <Button size="sm" variant="secondary" onClick={() => setDialog("rotate")}>
              Rotate credentials
            </Button>
          </div>
        </Card>
      </section>

      {shared ? (
        <section className="flex flex-col gap-3">
          <SectionHeader title="Setup" />
          <Card className="flex flex-col gap-4 p-5">
            {provider.hasSetup ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="type-body-sm text-foreground-soft">
                  {provider.configured
                    ? "Status delivery from AWS is set up."
                    : "Status delivery from AWS isn't finished. It completes once SNS confirms the subscription."}
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={setup.pending}
                  onClick={() => submit(setup.formAction, {})}
                >
                  Run setup again
                </Button>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-4">
              <span className="min-w-0">
                <span className="type-body-sm block font-semibold text-foreground">Default for new organizations</span>
                <span className="type-body-sm block text-muted-foreground">
                  {provider.isDefault
                    ? "New organizations start on this provider."
                    : "New organizations don't start on this provider."}{" "}
                  Set it on <TextLink href="/admin/settings/general">General</TextLink>.
                </span>
              </span>
              {provider.isDefault ? <Chip>default</Chip> : null}
            </div>
          </Card>
        </section>
      ) : null}

      {provider.webhook ? <WebhookSection id={provider.id} webhook={provider.webhook} /> : null}

      <details className="rounded-2xl border border-border bg-card">
        <summary className="type-body-sm cursor-pointer px-5 py-3 font-semibold text-foreground">Advanced</summary>
        <div className="flex flex-col gap-4 border-t border-border p-5">
          <KeyValueList
            items={[
              { label: "Id", value: provider.id, mono: true, copy: provider.id },
              { label: provider.adapter === "ses" ? "AWS account" : "Identity", value: provider.identity ?? "Not reported yet", mono: Boolean(provider.identity) },
              { label: "Added", value: <Time date={provider.createdAt} /> },
            ]}
          />
          <p className="type-body-sm text-muted-foreground">
            Quota and reputation rates are on <TextLink href="/admin/settings/system">Status</TextLink>.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setDialog("rename")}>
              Rename
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!canDelete}
              title={canDelete ? undefined : "Unassign every organization first."}
              onClick={(event) => {
                opener.remember(event);
                setDialog("delete");
              }}
            >
              Delete provider
            </Button>
          </div>
          {canDelete ? null : (
            <p className="type-body-sm text-muted-foreground">
              {shared ? "Unassign every organization to delete this provider." : "Remove its domains to delete this provider."}
            </p>
          )}
        </div>
      </details>

      {dialog === "rotate" ? (
        <RotateCredentialsDialog
          provider={{
            id: provider.id,
            name: provider.name,
            adapterLabel: provider.adapterLabel,
            shared,
            organizationCount: provider.organizations.length,
            credentialFieldSpecs: provider.credentialFieldSpecs,
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "rename" ? (
        <RenameProviderDialog provider={{ id: provider.id, name: provider.name, shared }} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === "convert" && provider.conversion ? (
        <ConvertDialog
          provider={{ id: provider.id, name: provider.name, organizationName }}
          conversion={provider.conversion}
          onClose={() => {
            setDialog(null);
            router.refresh();
          }}
        />
      ) : null}

      {adoptingFor ? (
        <AdoptDomainDialog
          provider={{ id: provider.id, adapterLabel: provider.adapterLabel }}
          organization={{ id: adoptingFor.id, name: adoptingFor.name, assignmentId: adoptingFor.assignmentId }}
          onClose={() => {
            setAdoptingFor(null);
            router.refresh();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(open) => !open && setDialog(null)}
        onCloseAutoFocus={opener.restore}
        title={`Delete ${provider.name}?`}
        consequence={
          shared
            ? "Its stored credentials are removed. Its SNS topic and EventBridge rule stay in AWS."
            : `${organizationName} can't send until an admin assigns it another provider.`
        }
        confirmLabel="Delete"
        tone="destructive"
        loading={remove.pending}
        onConfirm={() => {
          submit(remove.formAction, {});
          setDialog(null);
        }}
      />

      <ConfirmDialog
        open={dialog === "assign"}
        onOpenChange={(open) => !open && setDialog(null)}
        onCloseAutoFocus={opener.restore}
        title={`Assign an organization to ${provider.name}`}
        consequence="Its domains send through this provider. Nothing is created at AWS until it adds its first domain."
        confirmLabel="Assign"
        loading={assign.pending}
        onConfirm={() => {
          submit(assign.formAction, { organizationId: assignTo });
          setDialog(null);
        }}
      >
        <Field id="assign-organization" label="Organization" hint="Only organizations with no provider are listed." className="mt-3">
          <Select
            id="assign-organization"
            items={provider.assignable.map((org) => ({ value: org.id, label: org.name }))}
            value={assignTo}
            onValueChange={setAssignTo}
            size="md"
            shape="compact"
          />
        </Field>
      </ConfirmDialog>

      <ConfirmDialog
        open={unassigning !== null}
        onOpenChange={(open) => !open && setUnassigning(null)}
        onCloseAutoFocus={opener.restore}
        title={unassigning ? `Unassign ${unassigning.name}?` : ""}
        consequence="Deletes its space, configuration set and suppression list at the provider, and it can't send until it's assigned again. Refused while any of its domains use this provider."
        confirmLabel="Unassign"
        tone="destructive"
        loading={unassign.pending}
        onConfirm={() => {
          if (unassigning) submit(unassign.formAction, { organizationId: unassigning.id });
          setUnassigning(null);
        }}
      />
    </div>
  );
}

function CredentialsStatus({ provider }: { provider: AdminProviderDetail }) {
  const { ok, checkedAt } = provider.health;
  const lead = !checkedAt
    ? "Not checked yet"
    : ok === true
      ? "Verified"
      : ok === false
        ? "Failed"
        : `${provider.adapterLabel} can't check its own credentials. Last looked`;
  return (
    <p className="type-body-sm text-foreground-soft">
      {lead}
      {checkedAt ? (
        <>
          {" "}
          <Time date={checkedAt} />
        </>
      ) : null}
      . Stored credentials are never shown.
    </p>
  );
}

function TestButton({ id }: { id: string }) {
  const [state, formAction, pending] = useActionState<TestProviderState, FormData>(testProviderAction, idle);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <Button type="submit" size="sm" variant="secondary" loading={pending}>
        Test
      </Button>
      {state.status === "tested" ? (
        <span role="status" className={`type-body-sm ${state.ok === false ? "text-danger" : "text-muted-foreground"}`}>
          {state.ok === true ? "Passed." : state.ok === false ? `Failed: ${state.detail ?? "no reason given"}` : "Can't be checked."}
        </span>
      ) : null}
      {state.status === "error" ? (
        <span role="status" className="type-body-sm text-danger">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}

function WebhookSection({ id, webhook }: { id: string; webhook: { url: string; keySet: boolean } }) {
  const save = useAction(setWebhookKeyAction);
  return (
    <section className="flex flex-col gap-3">
      <SectionHeader title="Webhook" description="Configured by hand in the provider's dashboard." />
      <Card className="flex flex-col gap-4 p-5">
        <KeyValueList items={[{ label: "URL", value: webhook.url, mono: true, copy: webhook.url }]} />
        <form onSubmit={keepValues(save.formAction)} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <input type="hidden" name="id" value={id} />
          <Field
            id="webhook-key"
            label="Webhook public key"
            hint={webhook.keySet ? "A key is saved. Enter a new one to replace it." : "No key saved. Events are refused until one is."}
            className="min-w-0 flex-1"
          >
            <input
              id="webhook-key"
              name="webhookPublicKey"
              autoComplete="off"
              className={`${fieldClasses({ shape: "compact", size: "md" })} w-full font-mono`}
            />
          </Field>
          <Button type="submit" size="md" variant="secondary" loading={save.pending}>
            Save key
          </Button>
        </form>
      </Card>
    </section>
  );
}
