import { crc32, deflateRawSync } from "node:zlib";

export type ZipFixtureEntry = {
  name: string;
  data?: Buffer | string;
  deflate?: boolean;
  mode?: number;
  flags?: number;
  declaredSize?: number;
  checksum?: number;
};

/** Small ZIP builder for adversarial archive tests; never seeds application data. */
export function zipFixture(entries: ZipFixtureEntry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data ?? "fixture");
    const compressed = entry.deflate ? deflateRawSync(data) : data;
    const checksum = entry.checksum ?? crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(entry.flags ?? 0x800, 6);
    localHeader.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.declaredSize ?? data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(entry.flags ?? 0x800, 8);
    centralHeader.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.declaredSize ?? data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(((entry.mode ?? 0o100600) << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    local.push(localHeader, name, compressed);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + compressed.length;
  }
  const centralData = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralData.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralData, end]);
}

export function shapefileEntries(prefix = "dataset"): ZipFixtureEntry[] {
  return ["shp", "shx", "dbf", "prj"].map((extension) => ({ name: `${prefix}.${extension}`, data: `fixture ${extension}` }));
}
