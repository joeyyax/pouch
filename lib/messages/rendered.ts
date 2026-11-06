import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, type MessageRow } from "@/lib/db/schema";
import { applyLayoutOverrides, renderLayout, type DomainLayout } from "@/lib/domains/layout";
import { renderedBodyHash } from "./bulk-detect";
import type { MessageBody } from "./body-state";

/** What frames a domain's mail: its name and layout. */
export interface DomainFrame {
  name: string;
  layout: DomainLayout | null;
}

export interface SerializedRendered {
  /** The html part as the recipient got it: framed in the domain's layout when the send asked for one. */
  html: string | null;
  /** True when a layout wraps `html`. */
  framed: boolean;
  /** True when the layout or its template changed after the message was accepted, so this frame isn't the one sent. Null when it can't be told. */
  frame_changed: boolean | null;
}

/** Each domain's frame, in one read. */
export async function domainFrames(organizationId: string, domainIds: string[]): Promise<Map<string, DomainFrame>> {
  if (domainIds.length === 0) return new Map();
  const rows = await db
    .select({ id: domains.id, name: domains.name, layout: domains.layout })
    .from(domains)
    .where(and(eq(domains.organizationId, organizationId), inArray(domains.id, [...new Set(domainIds)])));
  return new Map(rows.map((row) => [row.id, { name: row.name, layout: row.layout }]));
}

type RenderedRow = Pick<MessageRow, "layout" | "layoutOverrides" | "bodyHash">;

/** Frames the body the way the worker does. Null when the body can't be read. */
export function renderSent(message: RenderedRow, body: MessageBody, frame: DomainFrame | undefined): SerializedRendered | null {
  if (body.state !== "available") return null;
  const layout = frame?.layout ?? null;
  const framed = Boolean(message.layout && layout && body.html);
  const html = framed ? renderLayout(body.html!, applyLayoutOverrides(layout!, message.layoutOverrides), frame!.name) : body.html;
  const sentHash = message.bodyHash;
  const frameChanged =
    sentHash === null || !frame
      ? null
      : renderedBodyHash(body.html, body.text, message.layout, layout, frame.name, message.layoutOverrides) !== sentHash;
  return { html, framed, frame_changed: frameChanged };
}
