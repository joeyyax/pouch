/** DMARC aggregate reports (RFC 7489 Appendix C): unpacking a zip, gzip or plain XML attachment and reading the XML. */
import { gunzipSync, inflateRawSync } from "node:zlib";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { DmarcDkimResult, DmarcPublishedPolicy, DmarcSpfResult } from "@/lib/db/schema";

/** Largest attachment read, compressed or not. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Largest XML a compressed attachment may expand to. */
export const MAX_XML_BYTES = 32 * 1024 * 1024;
/** Most rows one report may carry. */
export const MAX_RECORDS = 20_000;
/** Longest period one report may cover. */
const MAX_PERIOD_MS = 31 * 24 * 60 * 60 * 1000;

export class ReportParseError extends Error {}

export interface ReportRecord {
  sourceIp: string;
  count: number;
  disposition: string;
  dkim: "pass" | "fail";
  spf: "pass" | "fail";
  headerFrom: string;
  envelopeFrom: string | null;
  dkimResults: DmarcDkimResult[];
  spfResults: DmarcSpfResult[];
}

export interface AggregateReport {
  reporter: string;
  reporterEmail: string | null;
  reportId: string;
  begin: Date;
  end: Date;
  policy: DmarcPublishedPolicy;
  records: ReportRecord[];
}

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;

/** The first `.xml` entry of a zip, inflated under `MAX_XML_BYTES`. Stored and deflated entries only. */
function unzip(buffer: Buffer): Buffer {
  let end = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 0xffff); at -= 1) {
    if (buffer.readUInt32LE(at) === ZIP_END) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new ReportParseError("the zip has no central directory");

  const entries = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < entries; index += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== ZIP_CENTRAL) throw new ReportParseError("the zip's directory is damaged");
    const method = buffer.readUInt16LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + extraLength + commentLength;
    if (!name.toLowerCase().endsWith(".xml")) continue;

    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== ZIP_LOCAL) throw new ReportParseError("the zip's entry is damaged");
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + compressed);
    if (data.length !== compressed) throw new ReportParseError("the zip's entry is truncated");
    if (method === 0) {
      if (data.length > MAX_XML_BYTES) throw new ReportParseError("the report is larger than it may be");
      return data;
    }
    if (method === 8) return inflate(() => inflateRawSync(data, { maxOutputLength: MAX_XML_BYTES }));
    throw new ReportParseError(`the zip uses compression method ${method}`);
  }
  throw new ReportParseError("the zip holds no XML file");
}

function inflate(run: () => Buffer): Buffer {
  try {
    return run();
  } catch (error) {
    if (error instanceof RangeError || (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new ReportParseError(`the report expands past ${MAX_XML_BYTES / 1024 / 1024} MB`);
    }
    throw new ReportParseError("the attachment can't be decompressed");
  }
}

/** The report XML in an attachment, by its leading bytes rather than its declared type. */
export function unpackAttachment(content: Buffer): Buffer {
  if (content.length > MAX_ATTACHMENT_BYTES) throw new ReportParseError("the attachment is larger than a report may be");
  if (content.length >= 4 && content.readUInt32LE(0) === ZIP_LOCAL) return unzip(content);
  if (content.length >= 2 && content[0] === 0x1f && content[1] === 0x8b) return inflate(() => gunzipSync(content, { maxOutputLength: MAX_XML_BYTES }));
  return content;
}

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
  maxNestedTags: 32,
});

type Node = Record<string, unknown>;

function node(value: unknown): Node | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Node) : null;
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

function required(parent: Node | null, key: string, where: string): string {
  const value = text(parent?.[key]);
  if (value === null) throw new ReportParseError(`${where} has no ${key}`);
  return value;
}

function verdict(value: unknown): "pass" | "fail" {
  return text(value)?.toLowerCase() === "pass" ? "pass" : "fail";
}

function epoch(value: string, field: string): Date {
  if (!/^\d{1,12}$/.test(value)) throw new ReportParseError(`date_range ${field} isn't a timestamp`);
  return new Date(Number(value) * 1000);
}

function many(value: unknown): Node[] {
  return (Array.isArray(value) ? value : value === undefined ? [] : [value]).flatMap((item) => {
    const one = node(item);
    return one ? [one] : [];
  });
}

function readRecord(raw: Node): ReportRecord {
  const row = node(raw.row);
  const evaluated = node(row?.policy_evaluated);
  const identifiers = node(raw.identifiers);
  const auth = node(raw.auth_results);
  const count = required(row, "count", "a record");
  if (!/^\d{1,9}$/.test(count)) throw new ReportParseError("a record's count isn't a whole number");

  return {
    sourceIp: required(row, "source_ip", "a record").slice(0, 64),
    count: Number(count),
    disposition: text(evaluated?.disposition)?.toLowerCase().slice(0, 32) ?? "none",
    dkim: verdict(evaluated?.dkim),
    spf: verdict(evaluated?.spf),
    headerFrom: required(identifiers, "header_from", "a record").toLowerCase().slice(0, 253),
    envelopeFrom: text(identifiers?.envelope_from)?.toLowerCase().slice(0, 253) ?? null,
    dkimResults: many(auth?.dkim).flatMap((result) => {
      const domain = text(result.domain);
      return domain
        ? [{ domain: domain.toLowerCase().slice(0, 253), selector: text(result.selector)?.toLowerCase().slice(0, 253) ?? null, result: text(result.result)?.toLowerCase().slice(0, 32) ?? "none" }]
        : [];
    }),
    spfResults: many(auth?.spf).flatMap((result) => {
      const domain = text(result.domain);
      return domain
        ? [{ domain: domain.toLowerCase().slice(0, 253), scope: text(result.scope)?.toLowerCase().slice(0, 16) ?? null, result: text(result.result)?.toLowerCase().slice(0, 32) ?? "none" }]
        : [];
    }),
  };
}

function percent(value: unknown): number | null {
  const raw = text(value);
  return raw && /^\d{1,3}$/.test(raw) ? Math.min(Number(raw), 100) : null;
}

/** Reads one aggregate report's XML. Throws `ReportParseError` on anything it can't trust. */
export function parseReportXml(xml: Buffer | string, now = new Date()): AggregateReport {
  const source = typeof xml === "string" ? xml : xml.toString("utf8");
  if (source.length > MAX_XML_BYTES) throw new ReportParseError("the report is larger than it may be");
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new ReportParseError("the report declares a DOCTYPE");

  // The parser reads past a mismatched tag, so well-formedness is checked first.
  if (XMLValidator.validate(source) !== true) throw new ReportParseError("the report isn't well-formed XML");
  let document: Node;
  try {
    document = parser.parse(source) as Node;
  } catch {
    throw new ReportParseError("the report isn't well-formed XML");
  }
  const feedback = node(document.feedback);
  if (!feedback) throw new ReportParseError("the report has no feedback element");

  const metadata = node(feedback.report_metadata);
  const range = node(metadata?.date_range);
  const published = node(feedback.policy_published);
  const begin = epoch(required(range, "begin", "date_range"), "begin");
  const end = epoch(required(range, "end", "date_range"), "end");
  if (end.getTime() < begin.getTime() || end.getTime() - begin.getTime() > MAX_PERIOD_MS) {
    throw new ReportParseError("the report's date range isn't a period it could cover");
  }
  if (end.getTime() > now.getTime() + 24 * 60 * 60 * 1000) throw new ReportParseError("the report's date range ends in the future");

  const records = many(feedback.record);
  if (records.length === 0) throw new ReportParseError("the report has no records");
  if (records.length > MAX_RECORDS) throw new ReportParseError(`the report has more than ${MAX_RECORDS} records`);

  return {
    reporter: required(metadata, "org_name", "report_metadata").slice(0, 200),
    reporterEmail: text(metadata?.email)?.slice(0, 254) ?? null,
    reportId: required(metadata, "report_id", "report_metadata").slice(0, 200),
    begin,
    end,
    policy: {
      domain: required(published, "domain", "policy_published").toLowerCase().slice(0, 253),
      p: text(published?.p)?.toLowerCase() ?? null,
      sp: text(published?.sp)?.toLowerCase() ?? null,
      pct: percent(published?.pct),
      adkim: text(published?.adkim)?.toLowerCase() ?? null,
      aspf: text(published?.aspf)?.toLowerCase() ?? null,
    },
    records: records.map(readRecord),
  };
}
