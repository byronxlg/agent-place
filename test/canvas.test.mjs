import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WIDTH, HEIGHT, TILE, TILES_X, TILE_COUNT, PALETTE, PALETTE_RGB,
  inBounds, validColor, tileFor, assemble,
} from "../src/canvas.mjs";

test("geometry constants are consistent", () => {
  assert.equal(WIDTH % TILE, 0);
  assert.equal(HEIGHT % TILE, 0);
  assert.equal(TILE_COUNT, (WIDTH / TILE) * (HEIGHT / TILE));
  assert.equal(PALETTE.length, 16);
  assert.equal(PALETTE_RGB.length, 16);
  assert.deepEqual(PALETTE_RGB[5], [0xe5, 0x00, 0x00]);
});

test("inBounds", () => {
  assert.ok(inBounds(0, 0));
  assert.ok(inBounds(WIDTH - 1, HEIGHT - 1));
  assert.ok(!inBounds(-1, 0));
  assert.ok(!inBounds(WIDTH, 0));
  assert.ok(!inBounds(0, HEIGHT));
  assert.ok(!inBounds(1.5, 2));
  assert.ok(!inBounds("3", 2));
});

test("validColor", () => {
  assert.ok(validColor(0));
  assert.ok(validColor(15));
  assert.ok(!validColor(16));
  assert.ok(!validColor(-1));
  assert.ok(!validColor(2.5));
  assert.ok(!validColor("5"));
});

test("tileFor maps corners and interior correctly", () => {
  assert.deepEqual(tileFor(0, 0), { tile: 0, index: 0 });
  assert.deepEqual(tileFor(TILE - 1, 0), { tile: 0, index: TILE - 1 });
  assert.deepEqual(tileFor(TILE, 0), { tile: 1, index: 0 });
  assert.deepEqual(tileFor(0, TILE), { tile: TILES_X, index: 0 });
  assert.deepEqual(tileFor(WIDTH - 1, HEIGHT - 1), {
    tile: TILE_COUNT - 1,
    index: TILE * TILE - 1,
  });
});

test("assemble round-trips a pixel through tile maps", () => {
  const maps = new Array(TILE_COUNT).fill(null);
  const { tile, index } = tileFor(200, 130);
  maps[tile] = { [String(index)]: 7 };
  const out = assemble(maps);
  assert.equal(out[130 * WIDTH + 200], 7);
  assert.equal(out[0], 0);
  assert.equal(out.length, WIDTH * HEIGHT);
});

test("assemble ignores garbage keys", () => {
  const maps = new Array(TILE_COUNT).fill(null);
  maps[0] = { "not-a-number": 5, "-1": 5, "999999": 5, "0": 3 };
  const out = assemble(maps);
  assert.equal(out[0], 3);
  assert.equal(out.reduce((s, v) => s + v, 0), 3);
});
