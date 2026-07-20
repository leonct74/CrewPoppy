// Deterministic ZIP (STORE method) — MailPoppy's audited writer, carried over verbatim.
//
// The output depends ONLY on the entry names, their bytes, and a fixed mtime, so any
// machine produces a byte-identical archive. We deliberately do NOT compress: deflate
// output can vary across zlib versions, which would make the archive hash irreproducible
// for a verifier on a different runtime. Kept small and dependency-free so the archive
// writer itself is easy to audit.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS date/time in UTC (TZ-independent). Epochs before 1980 clamp to 1980-01-01. */
export function dosDateTime(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  const year = d.getUTCFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const date = ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

/**
 * @param {{name:string,data:Buffer}[]} entries — sorted by name inside for stable ordering.
 * @param {number} epochSeconds — fixed mtime (SOURCE_DATE_EPOCH).
 * @returns {Buffer}
 */
export function deterministicZip(entries, epochSeconds) {
  const { time, date } = dosDateTime(epochSeconds);
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const EXTERNAL_ATTR = (0o100644 << 16) >>> 0; // regular file, 0644
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of sorted) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: 0 = stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18); // compressed size (== size, stored)
    local.writeUInt32LE(e.data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    name.copy(local, 30);
    locals.push(local, e.data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); // central dir header signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(EXTERNAL_ATTR, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + e.data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // cd start disk
  eocd.writeUInt16LE(sorted.length, 8); // entries this disk
  eocd.writeUInt16LE(sorted.length, 10); // entries total
  eocd.writeUInt32LE(centralBuf.length, 12); // cd size
  eocd.writeUInt32LE(offset, 16); // cd offset
  eocd.writeUInt16LE(0, 20); // comment len
  return Buffer.concat([...locals, centralBuf, eocd]);
}
