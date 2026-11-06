"use client";

import { startTransition, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, fieldClasses } from "@/components/ui/field";
import { KeyValueList } from "@/components/ui/key-value-list";
import { brandNameFor, HEX_COLOR, renderLayoutPreview, type DomainLayout } from "@/lib/domains/layout";
import { idle } from "@/lib/dashboard/action-state";
import { toast } from "@/lib/toast";
import { BodyFrame } from "../_ui/body-frame";
import { useAction } from "../_ui/use-action";
import { RoleGate } from "../_ui/role-gate";
import { saveLayoutAction, uploadLayoutLogoAction } from "./actions";

const DEFAULT_ACCENT = "#1d46f5";

/** The body the preview frames. A real send's body is the caller's; this stands in for it. */
const SAMPLE = "<p>Your invite is ready.</p><p><a href=\"https://example.com\">Open it</a></p>";

export function LayoutCard({
  domainId,
  domainName,
  layout,
  canManage,
}: {
  domainId: string;
  domainName: string;
  layout: DomainLayout | null;
  canManage: boolean;
}) {
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="type-title text-base text-foreground">Layout</h2>
          <RoleGate allowed={canManage} reason="Your role doesn't let you change this domain's layout.">
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              {layout ? "Edit" : "Set a layout"}
            </Button>
          </RoleGate>
        </div>

        {layout ? (
          <>
            <KeyValueList
              items={[
                { label: "Brand", value: brandNameFor(layout, domainName) },
                layout.logoUrl?.startsWith("data:")
                  ? { label: "Logo", value: <span className="text-muted-foreground">embedded image</span> }
                  : {
                      label: "Logo",
                      value: layout.logoUrl ?? <span className="text-muted-foreground">none</span>,
                      mono: Boolean(layout.logoUrl),
                      ...(layout.logoUrl ? { copy: layout.logoUrl } : {}),
                    },
                {
                  label: "Accent",
                  value: (
                    <span className="flex items-center gap-2">
                      <span
                        className="inline-block size-4 rounded-full border border-border"
                        style={{ background: layout.accent }}
                        aria-hidden
                      />
                      <span className="font-mono">{layout.accent}</span>
                    </span>
                  ),
                  copy: layout.accent,
                },
                { label: "Footer", value: <span className="whitespace-pre-line">{layout.footer}</span> },
              ]}
            />
            <Preview layout={layout} domainName={domainName} />
          </>
        ) : (
          <p className="type-body-sm text-muted-foreground">
            No layout set. Sends from this domain render with no frame.
          </p>
        )}

        <p className="type-body-sm text-muted-foreground">
          Applies when a send passes <span className="font-mono">layout: true</span> or overrides the name,
          logo, accent or footer.
        </p>
      </Card>
    );
  }

  return <LayoutForm domainId={domainId} domainName={domainName} layout={layout} onDone={() => setEditing(false)} />;
}

function Preview({ layout, domainName }: { layout: DomainLayout; domainName: string }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="type-label text-muted-foreground">Preview</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <p className="type-body-sm text-muted-foreground">Light</p>
          <BodyFrame
            html={renderLayoutPreview(SAMPLE, layout, domainName, "light")}
            title="Layout — light"
            images
            className="h-80"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="type-body-sm text-muted-foreground">Dark, where supported</p>
          <BodyFrame
            html={renderLayoutPreview(SAMPLE, layout, domainName, "dark")}
            title="Layout — dark"
            images
            className="h-80"
          />
        </div>
      </div>
      <p className="type-body-sm text-muted-foreground">
        Apple Mail shows the dark frame. Gmail inverts colors itself and Outlook for Windows shows the light
        frame.
      </p>
    </div>
  );
}

const inputClass = `${fieldClasses({ shape: "compact", size: "md" })} w-full`;

function LayoutForm({
  domainId,
  domainName,
  layout,
  onDone,
}: {
  domainId: string;
  domainName: string;
  layout: DomainLayout | null;
  onDone: () => void;
}) {
  const { state, formAction, pending } = useAction(saveLayoutAction, (next) => {
    if (next.status === "ok") {
      toast({ title: next.message, variant: "success" });
      onDone();
    }
    if (next.status === "error" && !next.field) toast({ title: next.message, variant: "error" });
  });
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [draft, setDraft] = useState<DomainLayout>({
    brandName: layout ? brandNameFor(layout, domainName) : domainName,
    logoUrl: layout?.logoUrl ?? null,
    accent: layout?.accent ?? DEFAULT_ACCENT,
    footer: layout?.footer ?? "",
  });

  const error = state.status === "error" ? state : null;
  const accentValid = HEX_COLOR.test(draft.accent);
  const previewLayout: DomainLayout = { ...draft, accent: accentValid ? draft.accent : DEFAULT_ACCENT };

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | undefined>(undefined);

  // A plain async call to the server action, not a nested <form> — HTML doesn't allow a form
  // inside another form, and this control lives inside the save form's own layout.
  async function handleLogoFile(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setUploadError(undefined);
    const body = new FormData();
    body.set("id", domainId);
    body.set("logo", file);
    const result = await uploadLayoutLogoAction(idle, body);
    setUploading(false);
    if (result.status === "ok" && result.logoUrl) {
      setDraft((current) => ({ ...current, logoUrl: result.logoUrl! }));
    } else if (result.status === "error") {
      setUploadError(result.message);
    }
  }

  return (
    <Card className="flex flex-col gap-5 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="type-title text-base text-foreground">Layout</h2>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <form action={formAction} className="flex flex-col gap-4" id="layout-form">
          <input type="hidden" name="id" value={domainId} />
          <input type="hidden" name="logoUrl" value={draft.logoUrl ?? ""} />

          <Field
            id="layout-brand"
            label="Brand name"
            hint="The logo's alt text, and what shows when there's no logo."
            error={error?.field === "brandName" ? error.message : undefined}
            required
          >
            <input
              id="layout-brand"
              name="brandName"
              type="text"
              className={inputClass}
              placeholder={domainName}
              value={draft.brandName}
              onChange={(event) => setDraft({ ...draft, brandName: event.target.value })}
              autoComplete="off"
              required
            />
          </Field>

          <Field
            id="layout-logo-upload"
            label="Logo"
            hint="A PNG under 100KB at twice the display height: 64px tall renders at 32px. A transparent mark has to read on light and dark."
            error={error?.field === "logoUrl" ? error.message : uploadError}
          >
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <input
                  id="layout-logo-upload"
                  type="file"
                  accept="image/png"
                  className="text-sm text-foreground file:mr-3 file:rounded-full file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-secondary-foreground"
                  onChange={(event) => {
                    void handleLogoFile(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                  disabled={uploading}
                />
                {uploading ? <span className="type-body-sm text-muted-foreground">Uploading…</span> : null}
              </div>
              <div className="flex items-center gap-2">
                <input
                  id="layout-logo-url"
                  name="logoUrlInput"
                  type="url"
                  placeholder="or paste a hosted https URL"
                  className={`${inputClass} font-mono`}
                  value={draft.logoUrl ?? ""}
                  onChange={(event) => setDraft({ ...draft, logoUrl: event.target.value || null })}
                  autoComplete="off"
                  spellCheck={false}
                />
                {draft.logoUrl ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setDraft({ ...draft, logoUrl: null })}>
                    Remove
                  </Button>
                ) : null}
              </div>
            </div>
          </Field>

          <Field
            id="layout-accent"
            label="Accent"
            hint="A hex color, like #1d46f5."
            error={!accentValid && draft.accent !== "" ? "Use a hex color, like #1d46f5." : error?.field === "accent" ? error.message : undefined}
          >
            <span className="flex items-center gap-2">
              <input
                type="color"
                aria-label="Pick the accent color"
                value={accentValid ? draft.accent : DEFAULT_ACCENT}
                onChange={(event) => setDraft({ ...draft, accent: event.target.value })}
                className="size-9 shrink-0 cursor-pointer rounded-lg border border-border bg-transparent p-1"
              />
              <input
                id="layout-accent"
                name="accent"
                type="text"
                className={`${inputClass} font-mono`}
                value={draft.accent}
                onChange={(event) => setDraft({ ...draft, accent: event.target.value })}
                autoComplete="off"
                spellCheck={false}
                required
              />
            </span>
          </Field>

          <Field
            id="layout-footer"
            label="Footer"
            hint="One or two lines under the body. Newlines become lines."
            error={error?.field === "footer" ? error.message : undefined}
          >
            <textarea
              id="layout-footer"
              name="footer"
              rows={3}
              className={inputClass}
              placeholder="Scope · Portland, OR"
              value={draft.footer}
              onChange={(event) => setDraft({ ...draft, footer: event.target.value })}
              required
            />
          </Field>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="secondary" size="md" onClick={onDone}>
              Cancel
            </Button>
            <Button type="submit" size="md" disabled={pending}>
              {pending ? "Saving…" : "Save layout"}
            </Button>
          </div>
        </form>

        <Preview layout={previewLayout} domainName={domainName} />
      </div>

      {layout ? (
        <div className="flex justify-end border-t border-border pt-4">
          <Button type="button" variant="danger" size="sm" disabled={pending} onClick={() => setConfirmingRemove(true)}>
            Remove layout
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmingRemove}
        onOpenChange={setConfirmingRemove}
        title="Remove this layout?"
        consequence={
          <>
            Sends from {domainName} render with no frame, even with <span className="font-mono">layout: true</span>.
          </>
        }
        confirmLabel="Remove layout"
        tone="destructive"
        loading={pending}
        onConfirm={() => {
          const form = new FormData();
          form.set("id", domainId);
          form.set("clear", "true");
          startTransition(() => formAction(form));
          setConfirmingRemove(false);
        }}
      />
    </Card>
  );
}
