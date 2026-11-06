/**
 * Pins the wire token and everything built from it. These are constants on purpose: they're what
 * a recipient's pipeline parses, so a change here breaks a consumer silently. A failure means
 * either the change is wrong, or it's a deliberate break that needs a note in docs/decisions.md.
 */
import { describe, expect, it } from "vitest";
import { WIRE_HEADERS, WIRE_HEADER_TOKEN, WIRE_TOKEN, exportFilename, wireClass } from "@/lib/wire";

describe("the wire token", () => {
  it("is frozen at pouch, whatever the brand says", () => {
    expect(WIRE_TOKEN).toBe("pouch");
    expect(WIRE_HEADER_TOKEN).toBe("Pouch");
  });

  it("names the export headers", () => {
    expect(WIRE_HEADERS).toEqual({
      messageId: "X-Pouch-Message-Id",
      messageStatus: "X-Pouch-Message-Status",
      bodyStatus: "X-Pouch-Body-Status",
      bodyReason: "X-Pouch-Body-Reason",
    });
  });

  it("names the export files", () => {
    expect(exportFilename("messages", "2026-09-18", "csv")).toBe("pouch-messages-2026-09-18.csv");
    expect(exportFilename("bodies", "2026-09-18", "zip")).toBe("pouch-bodies-2026-09-18.zip");
    expect(exportFilename("data", "2026-09-18", "ndjson")).toBe("pouch-data-2026-09-18.ndjson");
  });

  it("names the classes in the frame we send", () => {
    expect(wireClass("page")).toBe("pouch-page");
    expect(wireClass("brand")).toBe("pouch-brand");
  });
});
