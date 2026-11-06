"use client";

import Link from "next/link";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, fieldClasses } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { FORWARD_TARGET_LIMIT } from "@/lib/addresses/constants";
import { CREATE_EXPIRY_DEFAULT, domainsForKey, EXTEND_OPTIONS, type AddressCreateOptions, type AddressKeyOption } from "@/lib/dashboard/views/addresses";
import { keepValues } from "../_ui/keep-values";
import { RoleGate } from "../_ui/role-gate";
import { KeyChip } from "../_ui/status";
import { useAction } from "../_ui/use-action";
import { createAddressAction } from "./actions";

const inputClass = `${fieldClasses({ shape: "compact", size: "md" })} w-full`;

function scopeLabel(key: AddressKeyOption): string {
  if (key.domainIds.length === 0) return "every domain";
  return key.domainIds.length === 1 ? "1 domain" : `${key.domainIds.length} domains`;
}

/** What stands between the operator and a first address, said once with the way past it. */
function Blocked({ title, children, href, cta }: { title: string; children: string; href: string; cta: string }) {
  return (
    <div className="flex flex-col gap-4">
      <Alert tone="info" title={title}>
        {children}
      </Alert>
      <div className="flex justify-end">
        <Link href={href} className={buttonVariants({ size: "md" })}>
          {cta}
        </Link>
      </div>
    </div>
  );
}

function CreateAddressForm({ options, onCancel }: { options: AddressCreateOptions; onCancel: () => void }) {
  const live = options.keys.filter((key) => key.mode === "live");
  const test = options.keys.filter((key) => key.mode === "test");
  const [keyId, setKeyId] = useState(live.length === 1 ? live[0]!.id : "");
  const key = live.find((option) => option.id === keyId);
  const reachable = domainsForKey(key, options.domains);
  const [domainId, setDomainId] = useState(() => (reachable.length === 1 ? reachable[0]!.id : ""));
  const domain = reachable.find((option) => option.id === domainId);
  const [localPart, setLocalPart] = useState("");
  // A field error shows on its field; anything else shows above the form. A success redirects.
  const { state, pending, formAction } = useAction(createAddressAction, () => {});
  const fieldError = (...fields: string[]) => (state.status === "error" && state.field && fields.includes(state.field) ? state.message : undefined);
  const general = state.status === "error" && !state.field ? state.message : null;

  function chooseKey(id: string) {
    setKeyId(id);
    const next = domainsForKey(
      live.find((option) => option.id === id),
      options.domains,
    );
    setDomainId(next.length === 1 ? next[0]!.id : next.some((option) => option.id === domainId) ? domainId : "");
  }

  const outOfReach = key && reachable.length === 0;

  return (
    <form onSubmit={keepValues(formAction)} className="flex flex-col gap-5">
      {general ? (
        <Alert tone="danger" title="Not created">
          {general}
        </Alert>
      ) : null}

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          id="address-key"
          label={
            <span className="inline-flex items-center gap-2">
              Key {key ? <KeyChip mode={key.mode} /> : null}
            </span>
          }
          hint={key ? `Reaches ${scopeLabel(key)}. Its endpoints hear the mail.` : "Its endpoints hear the mail. It reads and replies."}
          error={fieldError("key_id")}
        >
          <select id="address-key" name="key_id" required value={keyId} onChange={(event) => chooseKey(event.target.value)} className={inputClass}>
            <option value="">Choose a key</option>
            <optgroup label="Live">
              {live.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </optgroup>
            {test.length > 0 ? (
              <optgroup label="Test · can't create addresses">
                {test.map((option) => (
                  <option key={option.id} value={option.id} disabled>
                    {option.name} · test
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </Field>

        <Field
          id="address-domain"
          label="Domain"
          hint={
            outOfReach
              ? `${key.name} reaches no domain with inbound on. Choose another key, or turn on inbound on one of its domains.`
              : !key
                ? "Choose a key first."
                : undefined
          }
          error={fieldError("domain_id")}
        >
          <select
            id="address-domain"
            name="domain_id"
            required
            value={domainId}
            disabled={!key || reachable.length === 0}
            onChange={(event) => setDomainId(event.target.value)}
            className={inputClass}
          >
            <option value="">Choose a domain</option>
            {reachable.map((option) => (
              <option key={option.id} value={option.id}>
                {option.host}
              </option>
            ))}
          </select>
        </Field>

        <Field
          className="sm:col-span-2"
          id="address-local-part"
          label="Local part"
          hint={
            domain ? (
              <span className="break-all">
                {localPart.trim() ? "Mail reaches " : "Empty for a random one: "}
                <span className="font-mono">
                  {localPart.trim().toLowerCase() || "…"}@{domain.host}
                </span>
              </span>
            ) : (
              "Empty for a random one."
            )
          }
          error={fieldError("local_part")}
        >
          <input
            id="address-local-part"
            name="local_part"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="random"
            value={localPart}
            onChange={(event) => setLocalPart(event.target.value)}
            className={`${inputClass} font-mono`}
          />
        </Field>

        <Field className="sm:col-span-2" id="address-label" label="Label" error={fieldError("label")}>
          <input id="address-label" name="label" type="text" maxLength={200} placeholder="What it's for" className={inputClass} />
        </Field>

        <Field id="address-expiry" label="Expires" error={fieldError("expires_in", "expires_at")}>
          <select id="address-expiry" name="expires_in" defaultValue={String(CREATE_EXPIRY_DEFAULT)} className={inputClass}>
            {EXTEND_OPTIONS.map((option) => (
              <option key={option.seconds} value={option.seconds}>
                In {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id="address-cap" label="Message cap" hint="Mail past it drops and counts." error={fieldError("message_cap")}>
          <input id="address-cap" name="message_cap" type="number" min={1} max={1_000_000} step={1} inputMode="numeric" placeholder="No cap" className={inputClass} />
        </Field>
      </div>

      <Field
        id="address-forward"
        label="Forward to"
        hint={`Up to ${FORWARD_TARGET_LIMIT} mailboxes, one per line. Each gets a confirmation link, and nothing forwards until it's opened.`}
        error={fieldError("forward_to", "email")}
      >
        <textarea id="address-forward" name="forward_to" rows={2} spellCheck={false} placeholder="ops@example.com" className={`${inputClass} font-mono`} />
      </Field>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="md" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="md" loading={pending} disabled={!key || !domain}>
          Create address
        </Button>
      </div>
    </form>
  );
}

/** The list's "New address" action and its form. */
export function NewAddress({ options, canManage }: { options: AddressCreateOptions; canManage: boolean }) {
  const [open, setOpen] = useState(false);
  const live = options.keys.some((key) => key.mode === "live");

  return (
    <>
      <RoleGate allowed={canManage} reason="Your role doesn't let you create an address.">
        <Button size="md" onClick={() => setOpen(true)}>
          New address
        </Button>
      </RoleGate>
      {open ? (
        <Modal open size="lg" onOpenChange={(next) => !next && setOpen(false)} title="New address" description="An address receives mail on a domain's inbound host until it expires.">
          {!live ? (
            <Blocked
              title="No live key"
              href="/keys?state=create"
              cta="Create a key"
            >
              {options.keys.length > 0
                ? "An address answers to the key that creates it, and test keys can't create one. Create a live key, then come back."
                : "An address answers to the key that creates it. Create a live key, then come back."}
            </Blocked>
          ) : options.domains.length === 0 ? (
            <Blocked title="No domain has inbound on" href="/domains" cta="Open domains">
              An address lives on a domain&rsquo;s inbound host. Turn on inbound on a domain&rsquo;s page, then come back.
            </Blocked>
          ) : (
            <CreateAddressForm options={options} onCancel={() => setOpen(false)} />
          )}
        </Modal>
      ) : null}
    </>
  );
}
