import Link from "next/link";
import { Callout } from "@/components/ui/callout";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Condition } from "@/lib/metrics/conditions";
import { MuteMenu } from "./mute-menu";

function Links({ condition, canManage, className }: { condition: Condition; canManage: boolean; className?: string }) {
  if (condition.links.length === 0 && !condition.mute) return null;
  return (
    <p className={className}>
      {condition.links.map((link) => (
        <Link key={link.href} href={link.href} className="mr-4 inline-block whitespace-nowrap underline underline-offset-4 hover:no-underline">
          {link.label}
        </Link>
      ))}
      {condition.mute ? <MuteMenu offer={condition.mute} canManage={canManage} /> : null}
    </p>
  );
}

const CALLOUT_TONE = { danger: "danger", warning: "warn", info: "info" } as const;

function FullCallout({ condition, canManage }: { condition: Condition; canManage: boolean }) {
  return (
    <Callout tone={CALLOUT_TONE[condition.tone]} title={condition.title}>
      <p>{condition.body}</p>
      <Links condition={condition} canManage={canManage} className="mt-2" />
    </Callout>
  );
}

const GROUP = {
  warning: { label: "Worth a look", surface: "bg-warning-soft", divide: "divide-warning/15", icon: "warning", ink: "text-warning" },
  info: { label: "Changes in volume", surface: "bg-accent", divide: "divide-primary/10", icon: "info", ink: "text-primary-strong" },
} as const;

/** Two or more of a tone share one card, so they don't bury the numbers. */
function Group({ tone, conditions, canManage }: { tone: keyof typeof GROUP; conditions: Condition[]; canManage: boolean }) {
  if (conditions.length === 0) return null;
  if (conditions.length === 1 && conditions[0]) return <FullCallout condition={conditions[0]} canManage={canManage} />;
  const group = GROUP[tone];
  return (
    <section aria-label={group.label} className={cn("squircle rounded-2xl px-4 py-2", group.surface)}>
      <ul className={cn("divide-y", group.divide)}>
        {conditions.map((condition) => (
          <li key={`${condition.key}:${condition.title}`} className="flex gap-3 py-2.5">
            <Icon name={group.icon} strokeWidth={2.25} aria-hidden className={cn("mt-0.5 size-4 shrink-0", group.ink)} />
            <div className="min-w-0 flex-1 text-sm sm:flex sm:items-baseline sm:justify-between sm:gap-6">
              <div className="min-w-0">
                <p className={cn("font-semibold", group.ink)}>{condition.title}</p>
                <p className="text-foreground-soft">{condition.body}</p>
              </div>
              <Links condition={condition} canManage={canManage} className="mt-1 shrink-0 whitespace-nowrap text-foreground sm:mt-0" />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Danger in full, then warnings, then what changed. */
export function Conditions({ conditions, canManage }: { conditions: Condition[]; canManage: boolean }) {
  if (conditions.length === 0) return null;
  const danger = conditions.filter((condition) => condition.tone === "danger");

  return (
    <div className="flex flex-col gap-3">
      {danger.map((condition) => (
        <FullCallout key={`${condition.key}:${condition.title}`} condition={condition} canManage={canManage} />
      ))}
      <Group tone="warning" conditions={conditions.filter((condition) => condition.tone === "warning")} canManage={canManage} />
      <Group tone="info" conditions={conditions.filter((condition) => condition.tone === "info")} canManage={canManage} />
    </div>
  );
}
