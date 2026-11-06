/**
 * A minimal, streaming ZIP writer — stored (uncompressed) entries only, no external
 * dependency. `@aws-sdk/s3-request-presigner` is the one new-package allowance the brief
 * grants this feature; a zip library is not, and stored entries are enough for a bundle of
 * .eml files that are individually small.
 *
 * Entries are written one at a time as full local-file records (so the CRC is known up
 * front — nothing here buffers the whole archive, only one message's body at a time), and
 * the central directory — filenames and offsets only, not content — accumulates in memory
 * until `finish()` writes it. That directory is bytes per file, not bytes per message body,
 * so it stays small even across a few thousand entries.
 */

import { crc32 as zlibCrc32 } from "node:zlib";
import { ExportRefusedError } from "./errors";
import { EXPORT_MAX_ZIP_ENTRIES } from "./limits";
import { formatNumber } from "@/lib/format/number";

function crc32(data: Buffer): number {
  return zlibCrc32(data);
}

/** MS-DOS date/time packed into the ZIP format's two 16-bit fields, UTC. */
function dosDateTime(date: Date): { time: number; date: number } {
  const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const dosDate = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, date: dosDate };
}

interface CentralEntry {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

export class ZipWriter {
  private offset = 0;
  private entries: CentralEntry[] = [];

  /** One entry's local header plus its content — everything a reader needs to be sure it's a full file, since general-purpose bit 3 (streamed data descriptor) is never set here. */
  addFile(name: string, content: Buffer, modified = new Date()): Buffer {
    if (this.entries.length >= EXPORT_MAX_ZIP_ENTRIES) {
      throw new ExportRefusedError(
        `A bodies export holds at most ${formatNumber(EXPORT_MAX_ZIP_ENTRIES)} messages. Narrow the filter and request it again.`,
      );
    }
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(content);
    const { time, date } = dosDateTime(modified);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(1 << 11, 6); // UTF-8 filename flag
    header.writeUInt16LE(0, 8); // method: stored
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(content.length, 18); // compressed size
    header.writeUInt32LE(content.length, 22); // uncompressed size
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28); // extra field length

    this.entries.push({ name: nameBuf, crc, size: content.length, offset: this.offset, time, date });
    const record = Buffer.concat([header, nameBuf, content]);
    this.offset += record.length;
    return record;
  }

  /** Central directory plus the end-of-central-directory record. Call once, after every entry. */
  finish(): Buffer {
    const directoryStart = this.offset;
    const parts: Buffer[] = [];

    for (const entry of this.entries) {
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(20, 4); // version made by
      record.writeUInt16LE(20, 6); // version needed
      record.writeUInt16LE(1 << 11, 8); // UTF-8 filename flag
      record.writeUInt16LE(0, 10); // method: stored
      record.writeUInt16LE(entry.time, 12);
      record.writeUInt16LE(entry.date, 14);
      record.writeUInt32LE(entry.crc, 16);
      record.writeUInt32LE(entry.size, 20); // compressed size
      record.writeUInt32LE(entry.size, 24); // uncompressed size
      record.writeUInt16LE(entry.name.length, 28);
      record.writeUInt16LE(0, 30); // extra length
      record.writeUInt16LE(0, 32); // comment length
      record.writeUInt16LE(0, 34); // disk number
      record.writeUInt16LE(0, 36); // internal attrs
      record.writeUInt32LE(0, 38); // external attrs
      record.writeUInt32LE(entry.offset, 42);
      parts.push(record, entry.name);
      this.offset += record.length + entry.name.length;
    }

    const directorySize = this.offset - directoryStart;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4); // disk number
    end.writeUInt16LE(0, 6); // disk with central directory
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(directorySize, 12);
    end.writeUInt32LE(directoryStart, 16);
    end.writeUInt16LE(0, 20); // comment length
    parts.push(end);

    this.entries = [];
    return Buffer.concat(parts);
  }
}

/** Exported for tests: the checksum every zip reader verifies an entry's content against. */
export { crc32 };
