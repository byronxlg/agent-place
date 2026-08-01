import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { encodePng } from "../src/png.mjs";
import { PALETTE_RGB } from "../src/canvas.mjs";

function readChunks(buf) {
  assert.deepEqual(
    [...buf.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "PNG signature",
  );
  const chunks = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString("ascii");
    chunks.push({ type, data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  return chunks;
}

test("encodePng produces a structurally valid indexed PNG", () => {
  const w = 4, h = 3;
  const px = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const png = encodePng(px, w, h, PALETTE_RGB);
  const chunks = readChunks(png);
  assert.deepEqual(chunks.map((c) => c.type), ["IHDR", "PLTE", "IDAT", "IEND"]);

  const ihdr = chunks[0].data;
  assert.equal(ihdr.readUInt32BE(0), w);
  assert.equal(ihdr.readUInt32BE(4), h);
  assert.equal(ihdr[8], 8);
  assert.equal(ihdr[9], 3);

  assert.equal(chunks[1].data.length, 16 * 3);

  const raw = inflateSync(chunks[2].data);
  assert.equal(raw.length, h * (w + 1));
  assert.equal(raw[0], 0); // filter byte
  assert.deepEqual([...raw.subarray(1, 5)], [0, 1, 2, 3]);
  assert.deepEqual([...raw.subarray(6, 10)], [4, 5, 6, 7]);
});

test("encodePng scale replicates pixels", () => {
  const px = new Uint8Array([1, 2, 3, 4]);
  const png = encodePng(px, 2, 2, PALETTE_RGB, 3);
  const chunks = readChunks(png);
  assert.equal(chunks[0].data.readUInt32BE(0), 6);
  assert.equal(chunks[0].data.readUInt32BE(4), 6);
  const raw = inflateSync(chunks[2].data);
  assert.deepEqual([...raw.subarray(1, 7)], [1, 1, 1, 2, 2, 2]);
  // row 4 (0-indexed 3) should be the second source row
  assert.deepEqual([...raw.subarray(3 * 7 + 1, 3 * 7 + 7)], [3, 3, 3, 4, 4, 4]);
});
