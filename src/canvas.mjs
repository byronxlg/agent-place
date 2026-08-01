// Canvas geometry, palette, and tile math.
//
// The canvas is WIDTH x HEIGHT pixels, one byte per pixel (palette index).
// It is stored in DynamoDB as TILES_X * TILES_Y tile items, each holding a
// sparse map { "<index-within-tile>": colorInt }. Unset pixels are color 0
// (white). The map-per-tile layout makes every pixel write a single atomic
// UpdateItem with no read-modify-write contention.

export const WIDTH = 256;
export const HEIGHT = 256;
export const TILE = 64;
export const TILES_X = WIDTH / TILE;
export const TILES_Y = HEIGHT / TILE;
export const TILE_COUNT = TILES_X * TILES_Y;
export const COOLDOWN_SECONDS = 60;

// r/place 2017 palette.
export const PALETTE = [
  "#FFFFFF", "#E4E4E4", "#888888", "#222222",
  "#FFA7D1", "#E50000", "#E59500", "#A06A42",
  "#E5D900", "#94E044", "#02BE01", "#00D3DD",
  "#0083C7", "#0000EA", "#CF6EE4", "#820080",
];

export const PALETTE_RGB = PALETTE.map((hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]);

export function inBounds(x, y) {
  return Number.isInteger(x) && Number.isInteger(y) &&
    x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT;
}

export function validColor(c) {
  return Number.isInteger(c) && c >= 0 && c < PALETTE.length;
}

// Returns { tile, index } for a pixel coordinate.
export function tileFor(x, y) {
  const tx = Math.floor(x / TILE);
  const ty = Math.floor(y / TILE);
  return { tile: ty * TILES_X + tx, index: (y % TILE) * TILE + (x % TILE) };
}

// Assembles tile maps (array indexed by tile number, each a plain object of
// index -> color) into a flat Uint8Array of WIDTH*HEIGHT palette indices.
export function assemble(tileMaps) {
  const out = new Uint8Array(WIDTH * HEIGHT); // zero-filled = white
  for (let t = 0; t < TILE_COUNT; t++) {
    const px = tileMaps[t];
    if (!px) continue;
    const baseX = (t % TILES_X) * TILE;
    const baseY = Math.floor(t / TILES_X) * TILE;
    for (const [k, color] of Object.entries(px)) {
      const i = Number(k);
      if (!Number.isInteger(i) || i < 0 || i >= TILE * TILE) continue;
      const x = baseX + (i % TILE);
      const y = baseY + Math.floor(i / TILE);
      out[y * WIDTH + x] = color & 0x0f;
    }
  }
  return out;
}
