import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import type { SetupStep } from "@/lib/dashboard/views/setup";
import { cn } from "@/lib/utils";
import { SectionHeader } from "../_ui/section-header";
import type { SnippetLanguage } from "@/lib/dashboard/curl";
import { Snippet } from "../_ui/snippet";

/** Four steps to a first send, each ticked off by what the organization already has. */
export function SetupChecklist({ steps, sendSnippets }: { steps: SetupStep[]; sendSnippets: SnippetLanguage[] | null }) {
  const done = steps.filter((step) => step.done).length;
  const next = steps.find((step) => !step.done && step.href);

  return (
    <Card className="overflow-hidden p-0">
      <div className="px-6 pt-6">
        <SectionHeader
          title="Set up sending"
          description="Rates, volume and delivery times show here after the first live send."
          meta={`${done} of ${steps.length} done`}
        />
      </div>
      <ol className="mt-5 divide-y divide-border border-t border-border">
        {steps.map((step, index) => {
          const primary = step === next;
          return (
            <li key={step.key} className="flex gap-4 px-6 py-4" aria-current={primary ? "step" : undefined}>
              <span
                className={cn(
                  "mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold tabular-nums",
                  step.done
                    ? "bg-success-soft text-success-ink"
                    : primary
                      ? "bg-foreground text-background"
                      : "border border-border text-muted-foreground",
                )}
              >
                {step.done ? <Icon name="check" strokeWidth={2.5} className="size-3.5" /> : index + 1}
                <span className="sr-only">{step.done ? "Done" : "To do"}</span>
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                <div className="min-w-0">
                  <p className={cn("type-body font-medium", step.done ? "text-muted-foreground" : "text-foreground")}>
                    {step.title}
                  </p>
                  <p className="type-body-sm mt-0.5 text-muted-foreground">{step.detail}</p>
                  {step.example && sendSnippets ? (
                    <Snippet className="mt-3" languages={sendSnippets} />
                  ) : null}
                </div>
                {step.href && step.action ? (
                  <Link
                    href={step.href}
                    className={cn(
                      buttonVariants({ variant: primary ? "primary" : "secondary", size: "sm" }),
                      "shrink-0 self-start whitespace-nowrap",
                    )}
                  >
                    {step.action}
                  </Link>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
