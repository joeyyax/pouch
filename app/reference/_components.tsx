import type { ReactNode } from "react";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "@/components/ui/table";
import type { ApiField } from "@/lib/api-docs/introspect";
import { CODES } from "@/lib/api-docs/spec";
import { ERROR_CODES } from "@/lib/api/errors";
import type { ResponseField, RouteSpec } from "@/lib/api-docs/spec";
import { cn } from "@/lib/utils";

const METHOD_TONE: Record<RouteSpec["method"], ChipTone> = {
  GET: "good",
  POST: "signal",
  PATCH: "warn",
  DELETE: "issue",
};

export function MethodChip({ method }: { method: RouteSpec["method"] }) {
  return (
    <Chip tone={METHOD_TONE[method]} className="font-mono">
      {method}
    </Chip>
  );
}

function statusTone(status: number): ChipTone {
  if (status < 300) return "good";
  if (status < 500) return "warn";
  return "issue";
}

export function StatusChip({ status }: { status: number }) {
  return (
    <Chip tone={statusTone(status)} caps={false} className="font-mono">
      {status}
    </Chip>
  );
}

export function Path({ path }: { path: string }) {
  return <code className="font-mono text-15 text-foreground">{path}</code>;
}

export function SectionHeading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="type-h4 scroll-mt-24 text-foreground">
      {children}
    </h2>
  );
}

export function RequestFieldTable({ fields, label }: { fields: ApiField[]; label: string }) {
  if (fields.length === 0) return null;
  return (
    <Table label={label}>
      <TableHead>
        <TableRow>
          <TableHeaderCell>Field</TableHeaderCell>
          <TableHeaderCell>Type</TableHeaderCell>
          <TableHeaderCell>Required</TableHeaderCell>
          <TableHeaderCell>Description</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {fields.map((field) => (
          <TableRow key={field.name}>
            <TableCell className="whitespace-nowrap align-top font-mono text-sm">{field.name}</TableCell>
            <TableCell className="whitespace-nowrap align-top font-mono text-sm text-muted-foreground">{field.type}</TableCell>
            <TableCell className="align-top">
              {field.required ? (
                <Chip tone="neutral">required</Chip>
              ) : (
                <span className="text-muted-foreground">optional</span>
              )}
            </TableCell>
            <TableCell className="align-top text-foreground-soft">
              {field.description}
              {field.constraints.length > 0 ? (
                <span className="mt-1 block font-mono text-2xs text-muted-foreground">{field.constraints.join(" · ")}</span>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function ResponseFieldTable({ fields, label }: { fields: ResponseField[]; label: string }) {
  return (
    <Table label={label}>
      <TableHead>
        <TableRow>
          <TableHeaderCell>Field</TableHeaderCell>
          <TableHeaderCell>Type</TableHeaderCell>
          <TableHeaderCell>Description</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {fields.map((field) => (
          <TableRow key={field.name}>
            <TableCell className="whitespace-nowrap align-top font-mono text-sm">{field.name}</TableCell>
            <TableCell className="whitespace-nowrap align-top font-mono text-sm text-muted-foreground">{field.type}</TableCell>
            <TableCell className="align-top text-foreground-soft">{field.description}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function RouteErrorTable({ codes, label }: { codes: RouteSpec["errors"]; label: string }) {
  return (
    <Table label={label}>
      <TableHead>
        <TableRow>
          <TableHeaderCell>Code</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>When</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {codes.map((code) => (
          <TableRow key={code}>
            <TableCell className="whitespace-nowrap align-top font-mono text-sm">{code}</TableCell>
            <TableCell className="whitespace-nowrap align-top">
              <StatusChip status={ERROR_CODES[code]} />
            </TableCell>
            <TableCell className="align-top text-foreground-soft">{CODES[code].when}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("squircle rounded-2xl border border-border bg-card p-5 sm:p-6", className)}>{children}</div>;
}

export function SmtpReplyTable({
  rows,
  label,
}: {
  rows: { situation: string; reply: string }[];
  label: string;
}) {
  return (
    <Table label={label}>
      <TableHead>
        <TableRow>
          <TableHeaderCell>Situation</TableHeaderCell>
          <TableHeaderCell>Reply</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.situation}>
            <TableCell className="align-top">{row.situation}</TableCell>
            <TableCell className="whitespace-nowrap align-top font-mono text-sm">{row.reply}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
