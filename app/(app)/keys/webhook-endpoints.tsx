"use client";

import { Code } from "@/components/code";
import { startTransition, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Chip } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, fieldClasses } from "@/components/ui/field";
import { FieldMessage } from "@/components/ui/field-message";
import { Modal } from "@/components/ui/modal";
import { SecretReveal } from "@/components/ui/secret-reveal";
import { StatusDot } from "@/components/ui/status-dot";
import { DELIVERY_LABEL, DELIVERY_TONE } from "@/lib/dashboard/views/inbound";
import type { WebhookDeliveryDetailView, WebhookDeliveryView, WebhookEndpointView } from "@/lib/dashboard/views/webhooks";
import { KEY_WEBHOOK_EVENT_TYPES } from "@/lib/dashboard/views/webhooks";
import { toast } from "@/lib/toast";
import { SectionHeader } from "../_ui/section-header";
import { Time } from "../_ui/time";
import { toastError, useAction } from "../_ui/use-action";
import { RoleGate } from "../_ui/role-gate";
import {
  createWebhookEndpointAction,
  deleteWebhookEndpointAction,
  loadDeliveryAttemptsAction,
  revealWebhookSecretAction,
  rotateWebhookSecretAction,
  sendTestWebhookEventAction,
  toggleWebhookDisabledAction,
  updateWebhookEndpointAction,
  type CreateEndpointState,
  type RevealSecretState,
} from "./actions";
import { keepValues } from "../_ui/keep-values";
import { OverflowMenu } from "../_ui/overflow-menu";

const inputClass = `${fieldClasses({ shape: "compact", size: "md" })} w-full font-mono`;

const ROLE_REASON = "Your role doesn't let you change a webhook endpoint.";

function submit(dispatch: (form: FormData) => void, values: Record<string, string>) {
  const form = new FormData();
  for (const [name, value] of Object.entries(values)) form.set(name, value);
  startTransition(() => dispatch(form));
}

export function WebhookEndpoints({
  apiKeyId,
  endpoints,
  deliveriesByEndpoint,
  canManage,
}: {
  apiKeyId: string;
  endpoints: WebhookEndpointView[];
  deliveriesByEndpoint: Record<string, WebhookDeliveryView[]>;
  canManage: boolean;
}) {
  const [creating, setCreating] = useState(false);

  return (
    <Card className="p-5">
      <SectionHeader
        title="Webhooks"
        actions={
          <RoleGate allowed={canManage} reason="Your role doesn't let you create a webhook endpoint.">
            <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
              Add endpoint
            </Button>
          </RoleGate>
        }
      />

      {endpoints.length === 0 ? (
        <p className="type-body-sm mt-3 text-muted-foreground">
            No endpoints yet. Add one to get a signed POST when a message sent with this key resolves.
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-4">
          {endpoints.map((endpoint) => (
            <EndpointCard
              key={endpoint.id}
              apiKeyId={apiKeyId}
              endpoint={endpoint}
              deliveries={deliveriesByEndpoint[endpoint.id] ?? []}
              canManage={canManage}
            />
          ))}
        </div>
      )}

      {creating ? <CreateEndpointDialog apiKeyId={apiKeyId} open onOpenChange={setCreating} /> : null}
    </Card>
  );
}

function EndpointCard({
  apiKeyId,
  endpoint,
  deliveries,
  canManage,
}: {
  apiKeyId: string;
  endpoint: WebhookEndpointView;
  deliveries: WebhookDeliveryView[];
  canManage: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [openDelivery, setOpenDelivery] = useState<WebhookDeliveryView | null>(null);

  const toggleDisabled = useAction(toggleWebhookDisabledAction);
  const deleteEndpoint = useAction(deleteWebhookEndpointAction);
  const sendTest = useAction(sendTestWebhookEventAction);

  const failing =
    endpoint.lastFailureAt !== null && (!endpoint.lastSuccessAt || endpoint.lastFailureAt > endpoint.lastSuccessAt);
  const ids = { keyId: apiKeyId, endpointId: endpoint.id };

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm text-foreground [overflow-wrap:anywhere]">{endpoint.url}</p>
          {endpoint.description ? (
            <p className="type-body-sm mt-0.5 text-muted-foreground">{endpoint.description}</p>
          ) : null}
        </div>
        {endpoint.disabled ? (
          <Chip tone="issue">disabled</Chip>
        ) : failing ? (
          <Chip tone="warn">failing</Chip>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap gap-1">
        {endpoint.events.map((event) => (
          <Chip key={event} tone="value">
            {event}
          </Chip>
        ))}
      </div>

      <p className="type-body-sm mt-3 text-muted-foreground">
        {endpoint.disabled ? (
          <>
            Events don&apos;t reach it until it&apos;s enabled.
            {endpoint.lastFailureAt ? (
              <>
                {" "}
                Last failed <Time date={endpoint.lastFailureAt} />.
              </>
            ) : null}
          </>
        ) : failing && endpoint.lastFailureAt ? (
          <span className="text-warning">
            Last attempt failed <Time date={endpoint.lastFailureAt} />.
            {endpoint.lastSuccessAt ? (
              <>
                {" "}
                Last delivered <Time date={endpoint.lastSuccessAt} />.
              </>
            ) : null}
          </span>
        ) : endpoint.lastSuccessAt ? (
          <>
            Last delivered <Time date={endpoint.lastSuccessAt} />.
          </>
        ) : (
          "Nothing delivered yet. Send a test event to check it."
        )}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {endpoint.disabled ? (
          <form onSubmit={keepValues(toggleDisabled.formAction, { ...ids, disable: "false" })}>
            <RoleGate allowed={canManage} reason="Your role doesn't let you enable a webhook endpoint.">
              <Button type="submit" size="sm" variant="secondary" disabled={toggleDisabled.pending}>
                Enable
              </Button>
            </RoleGate>
          </form>
        ) : (
          <form onSubmit={keepValues(sendTest.formAction, ids)}>
            <RoleGate allowed={canManage} reason="Your role doesn't let you send a test event.">
              <Button type="submit" size="sm" variant="secondary" disabled={sendTest.pending}>
                Send test event
              </Button>
            </RoleGate>
          </form>
        )}
        <OverflowMenu
          size="sm"
          label={`More actions for ${endpoint.url}`}
          actions={[
            { label: "Edit", onSelect: () => setEditing(true), disabled: !canManage, reason: ROLE_REASON },
            { label: "Reveal secret", onSelect: () => setRevealing(true), disabled: !canManage, reason: ROLE_REASON },
            { label: "Rotate secret", onSelect: () => setRotating(true), disabled: !canManage, reason: ROLE_REASON },
            !endpoint.disabled && {
              label: "Disable",
              onSelect: () => submit(toggleDisabled.formAction, { ...ids, disable: "true" }),
              disabled: !canManage || toggleDisabled.pending,
              reason: canManage ? undefined : ROLE_REASON,
            },
            {
              label: "Delete",
              onSelect: () => setConfirmingDelete(true),
              destructive: true,
              disabled: !canManage,
              reason: ROLE_REASON,
            },
          ]}
        />
      </div>

      {deliveries.length > 0 ? (
        <details className="mt-4 rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 type-body-sm font-semibold text-foreground">
            Delivery log <span className="font-normal tabular-nums text-muted-foreground">{deliveries.length}</span>
          </summary>
          <ul className="divide-y divide-border border-t border-border">
            {deliveries.map((delivery) => (
              <li key={delivery.id}>
                <button
                  type="button"
                  onClick={() => setOpenDelivery(delivery)}
                  className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-secondary"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <StatusDot tone={DELIVERY_TONE[delivery.status]} pending={delivery.status === "pending"}>
                      {DELIVERY_LABEL[delivery.status]}
                    </StatusDot>
                    <span className="truncate font-mono text-xs text-muted-foreground">{delivery.eventType}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                    <span>
                      {delivery.attempts} {delivery.attempts === 1 ? "attempt" : "attempts"}
                    </span>
                    {delivery.lastStatusCode ? <span className="font-mono">{delivery.lastStatusCode}</span> : null}
                    <Time date={delivery.createdAt} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {editing ? <EditEndpointDialog apiKeyId={apiKeyId} endpoint={endpoint} onOpenChange={setEditing} /> : null}

      {revealing ? (
        <RevealDialog
          open={revealing}
          onOpenChange={setRevealing}
          endpointId={endpoint.id}
          apiKeyId={apiKeyId}
          action={revealWebhookSecretAction}
          endpointUrl={endpoint.url}
          title="Reveal signing secret?"
          description="The reveal is recorded in the activity log."
          confirmLabel="Reveal secret"
          revealedTitle="Signing secret"
        />
      ) : null}
      {rotating ? (
        <RevealDialog
          open={rotating}
          onOpenChange={setRotating}
          endpointId={endpoint.id}
          apiKeyId={apiKeyId}
          action={rotateWebhookSecretAction}
          endpointUrl={endpoint.url}
          title="Rotate signing secret?"
          description="The current secret stops verifying immediately. Update your receiver with the new one."
          confirmLabel="Rotate secret"
          destructive
          revealedTitle="New signing secret"
        />
      ) : null}

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title="Delete this endpoint?"
        consequence="Events stop reaching it immediately and its delivery log is deleted."
        confirmLabel="Delete endpoint"
        tone="destructive"
        loading={deleteEndpoint.pending}
        onConfirm={() => {
          const form = new FormData();
          form.set("keyId", apiKeyId);
          form.set("endpointId", endpoint.id);
          startTransition(() => deleteEndpoint.formAction(form));
          setConfirmingDelete(false);
        }}
        cancelLabel="Cancel"
      >
        <p className="mt-2 font-mono [overflow-wrap:anywhere] text-sm text-foreground-soft">{endpoint.url}</p>
      </ConfirmDialog>

      <DeliveryDialog endpointId={endpoint.id} delivery={openDelivery} onOpenChange={(open) => !open && setOpenDelivery(null)} />
    </div>
  );
}

function EventsField({ id, selected }: { id: string; selected: readonly string[] }) {
  return (
    <fieldset id={id}>
      <legend className="mb-1.5 text-sm font-medium text-foreground">Events</legend>
      <div className="flex flex-col gap-2">
        {KEY_WEBHOOK_EVENT_TYPES.map((event) => (
          <label key={event} className="flex min-w-0 items-center gap-2 font-mono type-body-sm text-foreground-soft">
            <Checkbox name="events" value={event} defaultChecked={selected.includes(event)} />
            <span className="min-w-0 break-all">{event}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function EditEndpointDialog({
  apiKeyId,
  endpoint,
  onOpenChange,
}: {
  apiKeyId: string;
  endpoint: WebhookEndpointView;
  onOpenChange: (open: boolean) => void;
}) {
  const { state, formAction, pending } = useAction(updateWebhookEndpointAction, (next) => {
    if (next.status === "ok") {
      toast({ title: next.message, variant: "success" });
      onOpenChange(false);
    }
  });
  const error = state.status === "error" ? state : null;
  const formId = `edit-endpoint-${endpoint.id}`;

  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      title="Edit endpoint"
      footer={
        <>
          <Button type="button" variant="secondary" size="md" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form={formId} size="md" disabled={pending}>
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={keepValues(formAction, { keyId: apiKeyId, endpointId: endpoint.id })}
        className="flex flex-col gap-4"
      >
        <Field
          id={`${formId}-url`}
          label="URL"
          hint="https, or http to localhost in development."
          error={error && (error.field === "url" || !error.field) ? error.message : undefined}
        >
          <input id={`${formId}-url`} name="url" type="url" required defaultValue={endpoint.url} className={inputClass} />
        </Field>
        <EventsField id={`${formId}-events`} selected={endpoint.events} />
        {error?.field === "events" ? <FieldMessage tone="error">{error.message}</FieldMessage> : null}
        <Field id={`${formId}-description`} label="Description" hint="Optional.">
          <input
            id={`${formId}-description`}
            name="description"
            type="text"
            defaultValue={endpoint.description ?? ""}
            className={inputClass}
          />
        </Field>
      </form>
    </Modal>
  );
}

function RevealDialog({
  open,
  onOpenChange,
  endpointId,
  endpointUrl,
  apiKeyId,
  action,
  title,
  description,
  confirmLabel,
  destructive = false,
  revealedTitle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  endpointId: string;
  endpointUrl: string;
  apiKeyId: string;
  action: (previous: RevealSecretState, form: FormData) => Promise<RevealSecretState>;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  revealedTitle: string;
}) {
  const { state, formAction, pending } = useAction<RevealSecretState>(action, toastError);

  if (state.status === "revealed") {
    return (
      <Modal open={open} onOpenChange={onOpenChange} title={revealedTitle} size="md">
        <SecretReveal
          value={state.secret}
          label="secret"
          title={<span className="font-mono text-base [overflow-wrap:anywhere]">{endpointUrl}</span>}
          description="Verify X-Signature against it."
          warning="Copy it now. Reveal secret shows it again later."
          onClose={() => onOpenChange(false)}
        />
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={title}
      description={description}
      footer={
        <>
          <Button type="button" variant="secondary" size="md" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <form onSubmit={keepValues(formAction, { keyId: apiKeyId, endpointId })}>
            <Button type="submit" variant={destructive ? "danger" : "primary"} size="md" loading={pending}>
              {confirmLabel}
            </Button>
          </form>
        </>
      }
    />
  );
}

function DeliveryDialog({
  endpointId,
  delivery,
  onOpenChange,
}: {
  endpointId: string;
  delivery: WebhookDeliveryView | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [loaded, setLoaded] = useState<{ id: string; detail: WebhookDeliveryDetailView | null } | null>(null);
  const [requested, setRequested] = useState<string | null>(null);

  if (delivery && requested !== delivery.id) {
    setRequested(delivery.id);
    void loadDeliveryAttemptsAction(endpointId, delivery.id).then((detail) => setLoaded({ id: delivery.id, detail }));
  }
  // Only what loaded for the open delivery, never the one before it.
  const current = delivery && loaded?.id === delivery.id ? loaded : null;
  const attempts = current?.detail?.attempts ?? (current ? [] : null);

  return (
    <Modal open={Boolean(delivery)} onOpenChange={onOpenChange} title={delivery ? delivery.eventType : ""} size="lg">
      {delivery ? (
        <div className="flex flex-col gap-4">
          <div>
            <p className="type-label text-muted-foreground">Payload</p>
            <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-secondary p-3 text-xs">
              {current?.detail ? (
                <Code language="json" code={JSON.stringify(current.detail.payload, null, 2)} />
              ) : (
                <span className="text-muted-foreground">{current ? "This delivery is gone." : "Loading…"}</span>
              )}
            </pre>
          </div>
          <div>
            <p className="type-label text-muted-foreground">Attempts</p>
            {attempts && attempts.length > 0 ? (
              <ul className="mt-1 flex flex-col gap-1">
                {attempts.map((attempt) => (
                  <li key={attempt.attempt} className="flex items-center justify-between gap-3 text-xs">
                    <span className="font-mono text-muted-foreground">#{attempt.attempt}</span>
                    <span className="font-mono">{attempt.statusCode ?? attempt.error ?? "no response"}</span>
                    <span className="text-muted-foreground">{attempt.durationMs}ms</span>
                    <Time date={attempt.createdAt} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="type-body-sm mt-1 text-muted-foreground">
                {attempts ? "No attempts yet." : "Loading…"}
              </p>
            )}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function CreateEndpointDialog({
  apiKeyId,
  open,
  onOpenChange,
}: {
  apiKeyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { state: created, formAction, pending } = useAction<CreateEndpointState>(createWebhookEndpointAction, () => {});
  const error = created.status === "error" ? created : null;

  function close() {
    onOpenChange(false);
  }

  if (created.status === "created") {
    return (
      <Modal open={open} onOpenChange={onOpenChange} title="Endpoint created" size="md">
        <SecretReveal
          value={created.secret}
          label="secret"
          title="Signing secret"
          description="Verify X-Signature against it."
          warning="Copy it now. Reveal secret shows it again later."
          onClose={close}
        />
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Add endpoint"
      description="It gets a signed POST for each event it subscribes to."
      footer={
        <>
          <Button type="button" variant="secondary" size="md" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="create-webhook-endpoint" size="md" disabled={pending}>
            {pending ? "Creating…" : "Create endpoint"}
          </Button>
        </>
      }
    >
      <form
        id="create-webhook-endpoint"
        onSubmit={keepValues(formAction, { keyId: apiKeyId })}
        className="flex flex-col gap-4"
      >
        <Field
          id="webhook-url"
          label="URL"
          hint="https, or http to localhost in development."
          error={error && (error.field === "url" || !error.field) ? error.message : undefined}
        >
          <input
            id="webhook-url"
            name="url"
            type="url"
            placeholder="https://example.com/webhooks/pouch"
            className={inputClass}
            required
          />
        </Field>
        <EventsField id="webhook-events" selected={["email.delivered", "email.bounced", "email.complained"]} />
        {error?.field === "events" ? <FieldMessage tone="error">{error.message}</FieldMessage> : null}
        <Field id="webhook-description" label="Description" hint="Optional.">
          <input id="webhook-description" name="description" type="text" className={inputClass} />
        </Field>
      </form>
    </Modal>
  );
}
