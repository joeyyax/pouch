"use client";

import { startTransition, useState, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, fieldClasses } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { formatSettingValue, SETTING_SECTIONS, type SettingDef, type SettingKey, type SettingSection, type SettingState } from "@/lib/settings/registry";
import { cn } from "@/lib/utils";

/** A line a page adds under one entry, from something outside the registry. */
export type SettingNotes = Partial<Record<SettingKey, { text: string; warning: boolean }>>;
import { keepValues } from "../../../_ui/keep-values";
import { SectionHeader } from "../../../_ui/section-header";
import { useAction } from "../../../_ui/use-action";
import { setSettingAction } from "./actions";

/** Set outside the dashboard, so it changes there. */
function pinned(setting: SettingState): boolean {
  return setting.source === "file" || setting.source === "env";
}

function Notes({ setting, note, configFile }: { setting: SettingState; note?: { text: string; warning: boolean }; configFile: string }) {
  return (
    <>
      {note ? (
        <p className={cn("type-body-sm mt-1", note.warning ? "text-warning" : "text-muted-foreground")} role={note.warning ? "status" : undefined}>
          {note.text}
        </p>
      ) : null}
      {setting.def.restart ? <p className="type-body-sm mt-1 text-muted-foreground">Takes effect when the app restarts.</p> : null}
      {setting.source === "file" ? (
        <p className="type-body-sm mt-1 text-muted-foreground">
          Set in <code className="font-mono text-xs">{configFile}</code>. Change it there and restart.
        </p>
      ) : null}
      {setting.source === "env" ? (
        <p className="type-body-sm mt-1 text-muted-foreground">
          Set by <code className="font-mono text-xs">{setting.def.env}</code>. Change it there and restart.
        </p>
      ) : null}
      {!setting.available && setting.dependsOn ? (
        <p className="type-body-sm mt-1 text-muted-foreground">Needs {setting.dependsOn.label}, which is off.</p>
      ) : null}
    </>
  );
}

/** The description and the range. A default at the top of its range is the limit. */
function hintOf(def: SettingDef): string {
  if (def.type !== "integer" && def.type !== "decimal") return def.description;
  const range =
    def.type === "decimal"
      ? `${formatSettingValue(def, def.min)} to ${formatSettingValue(def, def.max)}`
      : `${def.min} to ${def.max} ${def.unit}`;
  const limit = def.default === def.max ? ` The default, ${formatSettingValue(def, def.max)}, is the highest.` : "";
  return `${def.description} ${range}.${limit}`;
}

/** A number input with its unit beside it. Takes the props `Field` adds, so they land on the input. */
function UnitInput({ unit, className, ...props }: ComponentProps<"input"> & { unit: string }) {
  return (
    <div className="flex items-center gap-2">
      <input {...props} type="number" className={cn(fieldClasses({ shape: "compact", size: "md" }), "min-w-0 flex-1", className)} />
      <span className="type-body-sm shrink-0 text-muted-foreground">{unit}</span>
    </div>
  );
}

function SwitchRow({ setting, note, configFile }: { setting: SettingState; note?: { text: string; warning: boolean }; configFile: string }) {
  const save = useAction(setSettingAction);

  function setOn(checked: boolean) {
    const form = new FormData();
    form.set("key", setting.key);
    form.set("value", String(checked));
    startTransition(() => save.formAction(form));
  }

  return (
    <li className="flex items-center justify-between gap-4 p-5">
      <div className="min-w-0">
        <h4 className="text-sm font-semibold text-foreground">{setting.def.label}</h4>
        <p className="type-body-sm mt-1 text-muted-foreground">{setting.def.description}</p>
        <Notes setting={setting} note={note} configFile={configFile} />
      </div>
      <Switch
        checked={setting.available && setting.value === true}
        onCheckedChange={setOn}
        disabled={pinned(setting) || !setting.available || save.pending}
        aria-label={setting.def.label}
      />
    </li>
  );
}

function ValueRow({ setting, note, configFile }: { setting: SettingState; note?: { text: string; warning: boolean }; configFile: string }) {
  const save = useAction(setSettingAction);
  const [choice, setChoice] = useState(String(setting.value));
  const { def } = setting;
  const locked = pinned(setting) || !setting.available;
  const id = `setting-${setting.key}`;

  return (
    <li className="p-5">
      <form onSubmit={keepValues(save.formAction)} className="flex flex-col gap-3">
        <input type="hidden" name="key" value={setting.key} />
        <div className="max-w-[20rem]">
          <Field
            id={id}
            label={def.label}
            hint={hintOf(def)}
            error={save.state.status === "error" ? save.state.message : undefined}
          >
            {def.type === "enum" ? (
              <>
                <input type="hidden" name="value" value={choice} />
                <Select
                  id={id}
                  items={def.options.map((option) => ({ value: option, label: def.optionLabels?.[option] ?? option }))}
                  value={choice}
                  onValueChange={setChoice}
                  size="md"
                  shape="compact"
                  disabled={locked}
                />
              </>
            ) : def.type === "integer" || def.type === "decimal" ? (
              <UnitInput
                id={id}
                name="value"
                unit={def.unit}
                min={def.min}
                max={def.max}
                step={def.type === "decimal" ? def.step : undefined}
                required
                disabled={locked}
                defaultValue={String(setting.value)}
              />
            ) : null}
          </Field>
          <Notes setting={setting} note={note} configFile={configFile} />
        </div>
        <div>
          <Button type="submit" size="md" loading={save.pending} disabled={locked}>
            Save
          </Button>
        </div>
      </form>
    </li>
  );
}

const SETTINGS_EXPORT_PATH = "/api/dashboard/settings/export";

/** The config file's lock and the export of every setting. */
export function ConfigFileHeader({ configFile }: { configFile: string }) {
  return (
    <SectionHeader
      title="Config file"
      description={
        <>
          A value set in <code className="font-mono text-xs">{configFile}</code> is locked here. The export sets each value that differs from its default, in that file&apos;s shape, and lists the rest commented out.
        </>
      }
      actions={
        <Button as="a" href={SETTINGS_EXPORT_PATH} download variant="secondary" size="md">
          Export settings
        </Button>
      }
    />
  );
}

/** The settings registry, by section. Features are switches; other values save on their own. Every section when none are named. */
export function SettingsSections({
  settings,
  notes = {},
  configFile,
  sections,
}: {
  settings: SettingState[];
  notes?: SettingNotes;
  configFile: string;
  sections?: SettingSection[];
}) {
  const shown = settings.filter((setting) => !setting.def.configOnly);
  const listed = sections ? SETTING_SECTIONS.filter((section) => sections.includes(section.id)) : SETTING_SECTIONS;

  return (
    <>
      {listed.map((section) => {
        const rows = shown.filter((setting) => setting.def.section === section.id);
        if (rows.length === 0) return null;
        return (
          <section key={section.id} className="flex flex-col gap-3">
            <SectionHeader title={section.label} description={section.description} />
            <Card className="p-0">
              <ul className="divide-y divide-border">
                {rows.map((setting) =>
                  setting.def.type === "boolean" ? (
                    <SwitchRow key={setting.key} setting={setting} note={notes[setting.key]} configFile={configFile} />
                  ) : (
                    <ValueRow key={setting.key} setting={setting} note={notes[setting.key]} configFile={configFile} />
                  ),
                )}
              </ul>
            </Card>
          </section>
        );
      })}
    </>
  );
}
