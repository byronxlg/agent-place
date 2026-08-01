import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Store, hashKey, newApiKey, validName,
  ConflictError, UnauthorizedError, CooldownError,
} from "../src/store.mjs";
import { COOLDOWN_SECONDS, WIDTH, tileFor } from "../src/canvas.mjs";
import { fakeDoc } from "./helpers.mjs";

test("validName", () => {
  assert.ok(validName("abc"));
  assert.ok(validName("Agent_1-x"));
  assert.ok(!validName("ab"));
  assert.ok(!validName("a".repeat(33)));
  assert.ok(!validName("has space"));
  assert.ok(!validName("<script>"));
  assert.ok(!validName(42));
});

test("newApiKey format and hash", () => {
  const key = newApiKey();
  assert.match(key, /^ap_[0-9a-f]{40}$/);
  assert.equal(hashKey(key).length, 64);
  assert.notEqual(newApiKey(), newApiKey());
});

test("register: happy path then name conflict (case-insensitive)", async () => {
  const store = new Store(fakeDoc());
  const { name, api_key } = await store.register("picasso");
  assert.equal(name, "picasso");
  assert.match(api_key, /^ap_/);
  const agent = await store.getAgent(hashKey(api_key));
  assert.equal(agent.name, "picasso");
  assert.equal(agent.pixels_placed, 0);
  await assert.rejects(store.register("Picasso"), ConflictError);
});

test("claimPlacement: cooldown lifecycle", async () => {
  const store = new Store(fakeDoc());
  const { api_key } = await store.register("worker");
  const kh = hashKey(api_key);
  const t0 = 1_000_000_000_000;

  const first = await store.claimPlacement(kh, t0);
  assert.equal(first.pixels_placed, 1);

  // Immediately again: cooldown.
  await assert.rejects(
    () => store.claimPlacement(kh, t0 + 5000),
    (err) => {
      assert.ok(err instanceof CooldownError);
      assert.equal(err.nextAllowedAt, t0 + COOLDOWN_SECONDS * 1000);
      assert.equal(err.retryAfter, COOLDOWN_SECONDS - 5);
      return true;
    },
  );

  // After cooldown: allowed.
  const second = await store.claimPlacement(kh, t0 + COOLDOWN_SECONDS * 1000 + 1);
  assert.equal(second.pixels_placed, 2);
});

test("claimPlacement: unknown key is unauthorized", async () => {
  const store = new Store(fakeDoc());
  await assert.rejects(store.claimPlacement(hashKey("ap_nope"), 1), UnauthorizedError);
});

test("writePixel initializes tile map, records owner, lands in canvas", async () => {
  const doc = fakeDoc();
  const store = new Store(doc);
  await store.writePixel(200, 130, 7, "artist-a");
  await store.writePixel(201, 130, 9, "artist-b");
  const { tile, index } = tileFor(200, 130);
  assert.equal(doc.items.get(`T#${tile}|#`).px[String(index)], 7);
  const canvas = await store.canvas();
  assert.equal(canvas[130 * WIDTH + 200], 7);
  assert.equal(canvas[130 * WIDTH + 201], 9);

  assert.deepEqual(await store.pixelInfo(200, 130), {
    x: 200, y: 130, color: 7, placed_by: "artist-a",
  });
  assert.deepEqual(await store.pixelInfo(201, 130), {
    x: 201, y: 130, color: 9, placed_by: "artist-b",
  });
  // Untouched pixel: white, unowned.
  assert.deepEqual(await store.pixelInfo(0, 0), {
    x: 0, y: 0, color: 0, placed_by: null,
  });
});

test("writePixel heals a legacy tile that predates the owner map", async () => {
  const doc = fakeDoc();
  const { tile, index } = tileFor(10, 10);
  doc.items.set(`T#${tile}|#`, { pk: `T#${tile}`, sk: "#", px: { "5": 2 } });
  const store = new Store(doc);
  await store.writePixel(10, 10, 4, "healer");
  const item = doc.items.get(`T#${tile}|#`);
  assert.equal(item.px[String(index)], 4);
  assert.equal(item.own[String(index)], "healer");
  assert.equal(item.px["5"], 2); // pre-existing pixel untouched
});

test("since returns only newer placements, oldest first", async () => {
  const store = new Store(fakeDoc());
  await store.recordRecent(1, 1, 1, "a", 1000);
  await store.recordRecent(2, 2, 2, "b", 2000);
  await store.recordRecent(3, 3, 3, "c", 3000);
  const diff = await store.since(1000);
  assert.deepEqual(diff.map((p) => p.ts), [2000, 3000]);
  assert.equal((await store.since(3000)).length, 0);
  assert.equal((await store.since(0)).length, 3);
});

test("activity buckets recent placements", async () => {
  const store = new Store(fakeDoc());
  const now = 1_800_000_000_000;
  await store.recordRecent(1, 1, 1, "a", now - 1000);          // newest bucket
  await store.recordRecent(2, 2, 2, "a", now - 700_000);       // ~12min ago
  await store.recordRecent(3, 3, 3, "a", now - 7 * 3600_000);  // outside 6h window
  const act = await store.activity(now);
  assert.equal(act.bucket_seconds, 600);
  assert.equal(act.buckets.length, 36);
  assert.equal(act.buckets[35], 1);
  assert.equal(act.buckets[34], 1);
  assert.equal(act.buckets.reduce((s, v) => s + v, 0), 2);
  assert.equal(act.total_24h, 3);
});

test("recent + leaderboard aggregate correctly", async () => {
  const store = new Store(fakeDoc());
  const a = await store.register("alpha");
  const b = await store.register("beta");
  await store.claimPlacement(hashKey(a.api_key), 1000);
  await store.claimPlacement(hashKey(b.api_key), 1000);
  await store.claimPlacement(hashKey(b.api_key), 1000 + COOLDOWN_SECONDS * 1000 + 1);
  await store.recordRecent(1, 2, 3, "alpha", 1000);
  await store.recordRecent(4, 5, 6, "beta", 2000);

  const recent = await store.recent();
  assert.equal(recent.length, 2);
  assert.equal(recent[0].name, "beta"); // newest first

  const lb = await store.leaderboard();
  assert.equal(lb.total_agents, 2);
  assert.equal(lb.total_pixels_placed, 3);
  assert.equal(lb.agents[0].name, "beta");
});
