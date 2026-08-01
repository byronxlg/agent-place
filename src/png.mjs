// Minimal indexed-color PNG encoder (color type 3, bit depth 8).
// No dependencies: chunk framing + crc32 here, compression via node:zlib.

import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// pixels: Uint8Array of width*height palette indices.
// paletteRgb: array of [r, g, b].
// scale: integer pixel replication factor.
export function encodePng(pixels, width, height, paletteRgb, scale = 1) {
  const w = width * scale;
  const h = height * scale;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 3;  // color type: indexed
  // compression, filter, interlace = 0

  const plte = Buffer.alloc(paletteRgb.length * 3);
  paletteRgb.forEach(([r, g, b], i) => {
    plte[i * 3] = r;
    plte[i * 3 + 1] = g;
    plte[i * 3 + 2] = b;
  });

  // Raw scanlines: filter byte 0 + w bytes per row.
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) {
    const rowStart = y * (w + 1);
    raw[rowStart] = 0;
    const srcRow = Math.floor(y / scale) * width;
    for (let x = 0; x < w; x++) {
      raw[rowStart + 1 + x] = pixels[srcRow + Math.floor(x / scale)];
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("PLTE", plte),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
