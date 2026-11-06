/** DMARC aggregate report XML and the containers mailbox providers wrap it in. */
import { crc32, deflateRawSync, gzipSync } from "node:zlib";

export interface ReportRow {
  ip: string;
  count: number;
  dkim: "pass" | "fail";
  spf: "pass" | "fail";
  headerFrom?: string;
  envelopeFrom?: string;
  dkimResults?: { domain: string; selector?: string; result: string }[];
  spfResults?: { domain: string; result: string }[];
}

export interface ReportOptions {
  reporter?: string;
  reportId?: string;
  domain?: string;
  begin?: number;
  end?: number;
  rows?: ReportRow[];
}

/** Seconds since the epoch. */
export function epoch(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

export function reportXml(options: ReportOptions = {}): string {
  const domain = options.domain ?? "example.com";
  const end = options.end ?? epoch(new Date(Date.now() - 86_400_000));
  const rows = options.rows ?? [
    {
      ip: "54.240.1.1",
      count: 120,
      dkim: "pass",
      spf: "pass",
      envelopeFrom: `mail.${domain}`,
      dkimResults: [{ domain, selector: "abc", result: "pass" }],
      spfResults: [{ domain: `mail.${domain}`, result: "pass" }],
    },
  ];
  const records = rows
    .map(
      (row) => `
  <record>
    <row>
      <source_ip>${row.ip}</source_ip>
      <count>${row.count}</count>
      <policy_evaluated><disposition>none</disposition><dkim>${row.dkim}</dkim><spf>${row.spf}</spf></policy_evaluated>
    </row>
    <identifiers>
      <header_from>${row.headerFrom ?? domain}</header_from>
      ${row.envelopeFrom ? `<envelope_from>${row.envelopeFrom}</envelope_from>` : ""}
    </identifiers>
    <auth_results>
      ${(row.dkimResults ?? []).map((result) => `<dkim><domain>${result.domain}</domain>${result.selector ? `<selector>${result.selector}</selector>` : ""}<result>${result.result}</result></dkim>`).join("")}
      ${(row.spfResults ?? [{ domain: row.envelopeFrom ?? domain, result: row.spf }]).map((result) => `<spf><domain>${result.domain}</domain><result>${result.result}</result></spf>`).join("")}
    </auth_results>
  </record>`,
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" ?>
<feedback>
  <report_metadata>
    <org_name>${options.reporter ?? "google.com"}</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <report_id>${options.reportId ?? "17283746592837465"}</report_id>
    <date_range><begin>${options.begin ?? end - 86_400}</begin><end>${end}</end></date_range>
  </report_metadata>
  <policy_published><domain>${domain}</domain><adkim>r</adkim><aspf>r</aspf><p>none</p><sp>none</sp><pct>100</pct></policy_published>${records}
</feedback>`;
}

export function gzipped(xml: string): Buffer {
  return gzipSync(Buffer.from(xml));
}

/** A zip holding one deflated entry, the way Google sends a report. */
export function zipped(content: Buffer | string, name = "google.com!example.com!1!2.xml"): Buffer {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const deflated = deflateRawSync(data);
  const fileName = Buffer.from(name);
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fileName.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  central.writeUInt32LE(0, 42);

  const directoryOffset = local.length + fileName.length + deflated.length;
  const directorySize = central.length + fileName.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(directoryOffset, 16);

  return Buffer.concat([local, fileName, deflated, central, fileName, end]);
}

/** A report message as a mailbox provider sends it: one attachment, base64. */
export function reportMessage(attachment: Buffer, options: { to?: string; filename?: string; contentType?: string } = {}): Buffer {
  const boundary = "report-boundary";
  return Buffer.from(
    [
      "From: noreply-dmarc-support@google.com",
      `To: ${options.to ?? "token@reports.example.net"}`,
      "Subject: Report domain: example.com Submitter: google.com Report-ID: 17283746592837465",
      "Message-ID: <report@google.com>",
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain",
      "",
      "This is an aggregate report.",
      `--${boundary}`,
      `Content-Type: ${options.contentType ?? "application/zip"}; name="${options.filename ?? "report.zip"}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${options.filename ?? "report.zip"}"`,
      "",
      attachment.toString("base64").replace(/.{76}/g, "$&\r\n"),
      `--${boundary}--`,
      "",
    ].join("\r\n"),
  );
}
