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

test("writePixel initializes tile map and lands in canvas", async () => {
  const doc = fakeDoc();
  const store = new Store(doc);
  await store.writePixel(200, 130, 7);
  await store.writePixel(201, 130, 9);
  const { tile, index } = tileFor(200, 130);
  assert.equal(doc.items.get(`T#${tile}|#`).px[String(index)], 7);
  const canvas = await store.canvas();
  assert.equal(canvas[130 * WIDTH + 200], 7);
  assert.equal(canvas[130 * WIDTH + 201], 9);
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
