"use client";

import { keepValues } from "../../_ui/keep-values";
import Link from "next/link";
import { startTransition, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { StatusDot, type StatusDotTone } from "@/components/ui/status-dot";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, fieldClasses } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import type { MemberCounts } from "@/lib/dashboard/views/lists";
import type { SerializedList, SerializedMembership } from "@/lib/lists/serialize";
import { toast } from "@/lib/toast";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { CopyOnHover } from "../../_ui/copy-on-hover";
import { OverflowMenu } from "../../_ui/overflow-menu";
import { PageHeader } from "../../_ui/page-header";
import { RowActions } from "../../_ui/row-actions";
import { SegmentedLinks } from "../../_ui/segmented-links";
import { Term } from "../../_ui/term";
import { Time } from "../../_ui/time";
import { useAction } from "../../_ui/use-action";
import {
  addMemberAction,
  deleteListAction,
  removeMemberAction,
  unsubscribeMemberAction,
  updateListAction,
  updateMemberAttributesAction,
} from "../actions";
import { ImportSummary, useMemberImport, type MemberImportResult } from "./member-import";
import { formatNumber } from "@/lib/format/number";

type MemberStatus = SerializedMembership["status"];

const STATUS_TONE: Record<MemberStatus, StatusDotTone> = {
  pending: "neutral",
  subscribed: "good",
  unsubscribed: "issue",
};

const STATUS_LABEL: Record<MemberStatus, string> = {
  subscribed: "Subscribed",
  pending: "Pending",
  unsubscribed: "Unsubscribed",
};

const STATUS_ORDER: MemberStatus[] = ["subscribed", "pending", "unsubscribed"];

function membersHref(listId: string, query: { status?: MemberStatus | null; cursor?: string }): string {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.cursor) params.set("cursor", query.cursor);
  const suffix = params.toString();
  return suffix ? `/lists/${listId}?${suffix}` : `/lists/${listId}`;
}

/** Hidden when there's nothing to split: one status and no filter on. */
function StatusFilter({ listId, counts, total, status }: { listId: string; counts: MemberCounts; total: number; status: MemberStatus | null }) {
  const present = STATUS_ORDER.filter((option) => counts[option] > 0 || option === status);
  if (!status && present.length < 2) return null;
  return (
    <div className="pb-4">
      <SegmentedLinks
        label="Status"
        options={[
          { href: membersHref(listId, {}), label: `All ${formatNumber(total)}`, active: status === null },
          ...present.map((option) => ({
            href: membersHref(listId, { status: option }),
            label: `${STATUS_LABEL[option]} ${formatNumber(counts[option])}`,
            active: option === status,
          })),
        ]}
      />
    </div>
  );
}

export function ListDetail({
  list,
  domainName,
  members,
  counts,
  total,
  status,
  nextCursor,
  paged,
}: {
  list: SerializedList;
  domainName: string;
  members: SerializedMembership[];
  counts: MemberCounts;
  total: number;
  status: MemberStatus | null;
  nextCursor: string | null;
  paged: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editingMember, setEditingMember] = useState<SerializedMembership | null>(null);
  const add = useAction(addMemberAction, (next) => {
    reportUnlessField(next);
    if (next.status === "ok") setAdding(false);
  });
  const edit = useAction(updateListAction, (next) => {
    reportUnlessField(next);
    if (next.status === "ok") setEditing(false);
  });
  const del = useAction(deleteListAction);
  const remove = useAction(removeMemberAction);
  const unsubscribe = useAction(unsubscribeMemberAction);
  const [confirming, setConfirming] = useState<{ kind: "unsubscribe" | "remove"; member: SerializedMembership } | null>(null);
  const [imported, setImported] = useState<MemberImportResult | null>(null);
  const importer = useMemberImport(list.id, setImported);
  const { copy } = useCopyToClipboard();

  async function copyAddress(address: string) {
    if (await copy(address)) toast({ title: "Address copied.", variant: "success" });
    else toast({ title: "Couldn’t copy the address", description: "Your browser blocked the clipboard.", variant: "error" });
  }

  return (
    <>
      <PageHeader
        eyebrow="Lists"
        title={list.name}
        status={
          <Term chip term={list.double_opt_in ? "double_opt_in" : "single_opt_in"}>
            <Chip tone={list.double_opt_in ? "neutral" : "warn"}>{list.double_opt_in ? "Double opt-in" : "Single opt-in"}</Chip>
          </Term>
        }
        meta={`${formatNumber(total)} ${total === 1 ? "member" : "members"} on ${domainName}.`}
        actions={
          <>
            {importer.input}
            {importer.pending ? (
              <span role="status" className="type-body-sm text-muted-foreground">
                Importing…
              </span>
            ) : null}
            <Button size="md" onClick={() => setAdding(true)}>
              Add member
            </Button>
            <OverflowMenu
              actions={[
                { label: "Edit list", onSelect: () => setEditing(true) },
                { label: "Import CSV", onSelect: importer.choose, disabled: importer.pending, reason: "Importing…" },
                total > 0 && { label: "Export CSV", href: `/api/dashboard/lists/${list.id}/export`, download: true },
                { label: "Delete list", onSelect: () => setConfirmingDelete(true), destructive: true },
              ]}
            />
          </>
        }
      />

      {imported ? <ImportSummary result={imported} onDismiss={() => setImported(null)} /> : null}

      {editing ? (
        <Modal
          open
          onOpenChange={(open) => !open && setEditing(false)}
          title="Edit list"
          description="The name people see, and how new addresses join."
        >
          <form onSubmit={keepValues(edit.formAction)} className="flex flex-col gap-5">
            <input type="hidden" name="id" value={list.id} />
            <Field id="list-name" label="Name" error={fieldError(edit.state, "name")}>
              <input
                id="list-name"
                name="name"
                type="text"
                required
                autoFocus
                defaultValue={list.name}
                className={`${fieldClasses({ shape: "compact", size: "md" })} w-full`}
              />
            </Field>
            <label className="flex items-start gap-2 text-sm text-foreground-soft">
              <input type="checkbox" name="double_opt_in" value="true" defaultChecked={list.double_opt_in} className="mt-0.5" />
              Double opt-in. New members confirm before they receive a batch. Members already on the list keep the mode they joined under.
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" size="md" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button type="submit" size="md" loading={edit.pending}>
                Save list
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}

      {adding ? (
        <Modal
          open
          onOpenChange={(open) => !open && setAdding(false)}
          title="Add member"
          description="One address, added by hand. Everything else grows by subscribe or import."
        >
          <form onSubmit={keepValues(add.formAction)} className="flex flex-col gap-5">
            <input type="hidden" name="list_id" value={list.id} />
            <Field id="member-address" label="Address" error={fieldError(add.state, "address")}>
              <input
                id="member-address"
                name="address"
                type="email"
                required
                autoFocus
                placeholder="ada@example.com"
                className={`${fieldClasses({ shape: "compact", size: "md" })} w-full`}
              />
            </Field>
            <p className="text-sm text-foreground-soft">
              {list.double_opt_in
                ? "This list is double opt-in, so the address confirms before it receives a batch."
                : "This list is single opt-in, so the address can receive a batch right away."}
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" size="md" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button type="submit" size="md" loading={add.pending}>
                Add member
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}

      <StatusFilter listId={list.id} counts={counts} total={total} status={status} />

      {members.length === 0 && status ? (
        <EmptyState icon="mail" title={`No ${status} members`} description={`None of the ${formatNumber(total)} members are ${status}.`} />
      ) : members.length === 0 ? (
        <EmptyState
          icon="mail"
          title="No members yet"
          description="Next, add an address or import a CSV. Sends with subscribe add more on their own."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="md" onClick={() => setAdding(true)}>
                Add member
              </Button>
              <Button variant="secondary" size="md" onClick={importer.choose} disabled={importer.pending}>
                {importer.pending ? "Importing…" : "Import CSV"}
              </Button>
            </div>
          }
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <ul className="divide-y divide-border">
            {members.map((member) => (
              <li
                key={member.id}
                className="group/row flex items-center gap-3 px-5 py-3"
              >
                <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                  <span className="min-w-0">
                    <CopyOnHover value={member.address} label="address" className="flex font-mono text-sm" hideOnTouch>
                      {member.address}
                    </CopyOnHover>
                    <span className="block truncate text-2xs text-muted-foreground">
                      {member.source} · <Time date={new Date(member.created_at)} />
                    </span>
                  </span>
                  <StatusDot tone={STATUS_TONE[member.status]} pending={member.status === "pending"}>
                    {STATUS_LABEL[member.status]}
                  </StatusDot>
                </span>
                <RowActions
                  label={`Actions for ${member.address}`}
                  actions={[
                    { label: "Copy address", touchOnly: true, onSelect: () => void copyAddress(member.address) },
                    { label: "Attributes", onSelect: () => setEditingMember(member) },
                    member.status !== "unsubscribed" && {
                      label: "Unsubscribe",
                      onSelect: () => setConfirming({ kind: "unsubscribe", member }),
                    },
                    { label: "Remove", onSelect: () => setConfirming({ kind: "remove", member }), destructive: true },
                  ]}
                />
              </li>
            ))}
          </ul>
        </Card>
      )}

      {paged || nextCursor ? (
        <div className="mt-4 flex items-center justify-between text-sm">
          {paged ? (
            <Link href={membersHref(list.id, { status })} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Newest
            </Link>
          ) : (
            <span />
          )}
          {nextCursor ? (
            <Link
              href={membersHref(list.id, { status, cursor: nextCursor })}
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              Older
            </Link>
          ) : null}
        </div>
      ) : null}

      {editingMember ? (
        <AttributesDialog
          key={editingMember.id}
          listId={list.id}
          member={editingMember}
          onClose={() => setEditingMember(null)}
        />
      ) : null}

      <ConfirmDialog
        open={confirming?.kind === "unsubscribe"}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={confirming ? `Unsubscribe ${confirming.member.address}?` : ""}
        consequence="It stops receiving batches from this list. The row stays, marked unsubscribed."
        confirmLabel="Unsubscribe"
        tone="destructive"
        loading={unsubscribe.pending}
        onConfirm={() => {
          if (!confirming) return;
          const form = new FormData();
          form.set("list_id", list.id);
          form.set("address", confirming.member.address);
          startTransition(() => unsubscribe.formAction(form));
          setConfirming(null);
        }}
      />

      <ConfirmDialog
        open={confirming?.kind === "remove"}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={confirming ? `Remove ${confirming.member.address}?` : ""}
        consequence="The membership and its attributes are deleted. A later subscribe or import adds it back as new."
        confirmLabel="Remove member"
        tone="destructive"
        loading={remove.pending}
        onConfirm={() => {
          if (!confirming) return;
          const form = new FormData();
          form.set("list_id", list.id);
          form.set("member_id", confirming.member.id);
          startTransition(() => remove.formAction(form));
          setConfirming(null);
        }}
      />

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={`Delete ${list.name}?`}
        consequence="Every membership on this list is removed. Addresses already sent to keep their message history."
        confirmLabel="Delete list"
        tone="destructive"
        loading={del.pending}
        onConfirm={() => {
          const form = new FormData();
          form.set("id", list.id);
          startTransition(() => del.formAction(form));
          setConfirmingDelete(false);
        }}
        cancelLabel="Cancel"
      />
    </>
  );
}

type FormState = { status: string; message?: string; field?: string };

function fieldError(state: FormState, field: string): string | undefined {
  return state.status === "error" && state.field === field ? state.message : undefined;
}

/** Toasts what the form can't show on a field. */
function reportUnlessField(state: FormState): void {
  if (state.status === "ok" && state.message) toast({ title: state.message, variant: "success" });
  if (state.status === "error" && state.message && !state.field) toast({ title: state.message, variant: "error" });
}

/** Replaces a member's merge fields. A blank key drops the row, so clearing one is a save away. */
function AttributesDialog({
  listId,
  member,
  onClose,
}: {
  listId: string;
  member: SerializedMembership;
  onClose: () => void;
}) {
  const save = useAction(updateMemberAttributesAction);
  const [rows, setRows] = useState(() => Object.entries(member.attributes).map(([key, value]) => ({ key, value })));

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Attributes"
      description={`Merge fields substituted into a batch for ${member.address}.`}
      size="md"
      footer={
        <>
          <Button type="button" variant="secondary" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="member-attributes" size="md" disabled={save.pending}>
            {save.pending ? "Saving…" : "Save attributes"}
          </Button>
        </>
      }
    >
      <form
        id="member-attributes"
        action={(form) => {
          save.formAction(form);
          onClose();
        }}
        className="flex flex-col gap-3"
      >
        <input type="hidden" name="list_id" value={listId} />
        <input type="hidden" name="member_id" value={member.id} />
        {rows.length === 0 ? (
          <p className="type-body-sm text-muted-foreground">No attributes yet.</p>
        ) : null}
        {rows.map((row, index) => (
          <div key={index} className="grid grid-cols-2 gap-2">
            <input
              name="attribute_key"
              aria-label="Attribute name"
              defaultValue={row.key}
              placeholder="first_name"
              className={`${fieldClasses({ shape: "compact", size: "md" })} w-full font-mono`}
            />
            <input
              name="attribute_value"
              aria-label="Attribute value"
              defaultValue={row.value}
              className={`${fieldClasses({ shape: "compact", size: "md" })} w-full`}
            />
          </div>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => setRows((current) => [...current, { key: "", value: "" }])}
        >
          Add attribute
        </Button>
      </form>
    </Modal>
  );
}
