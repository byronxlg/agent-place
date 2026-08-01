import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../src/index.mjs";
import { Store, hashKey } from "../src/store.mjs";
import { WIDTH, HEIGHT, COOLDOWN_SECONDS } from "../src/canvas.mjs";

// Reuse the fake doc client via a tiny local copy-free import trick: the
// store tests own the fake; here we only need a Store backed by it, so we
// re-create a minimal one through the public Store API with a stubbed doc.
// To avoid duplication we import the fake from a shared helper.
import { fakeDoc } from "./helpers.mjs";

function req(method, path, { body, key, query } = {}) {
  return {
    rawPath: path,
    requestContext: { http: { method } },
    headers: {
      host: "example.test",
      "x-forwarded-proto": "https",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    queryStringParameters: query,
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function newStore() {
  return new Store(fakeDoc());
}

test("GET / serves the viewer page", async () => {
  const res = await handleRequest(req("GET", "/"), newStore());
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /text\/html/);
  assert.match(res.body, /agent-place/);
  assert.match(res.body, /https:\/\/example\.test/);
});

test("viewer page has social meta and favicon", async () => {
  const res = await handleRequest(req("GET", "/"), newStore());
  assert.match(res.body, /property="og:image" content="https:\/\/example\.test\/api\/canvas\.png\?scale=3"/);
  assert.match(res.body, /property="og:title"/);
  assert.match(res.body, /name="twitter:card"/);
  assert.match(res.body, /rel="icon" href="data:image\/svg\+xml,/);
});

test("GET /skill.md serves agent docs", async () => {
  const res = await handleRequest(req("GET", "/skill.md"), newStore());
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /api\/agents\/register/);
});

test("register -> place -> canvas -> cooldown flow", async () => {
  const store = newStore();

  const reg = await handleRequest(
    req("POST", "/api/agents/register", { body: { name: "flow-test" } }),
    store,
  );
  assert.equal(reg.statusCode, 201);
  const { api_key } = JSON.parse(reg.body);
  assert.match(api_key, /^ap_/);

  const place = await handleRequest(
    req("POST", "/api/pixels", { key: api_key, body: { x: 10, y: 20, color: 5 } }),
    store,
  );
  assert.equal(place.statusCode, 200);
  assert.equal(JSON.parse(place.body).pixels_placed, 1);

  const again = await handleRequest(
    req("POST", "/api/pixels", { key: api_key, body: { x: 11, y: 20, color: 5 } }),
    store,
  );
  assert.equal(again.statusCode, 429);
  const cooldown = JSON.parse(again.body);
  assert.equal(cooldown.error.code, "cooldown");
  assert.ok(cooldown.retry_after >= COOLDOWN_SECONDS - 1);
  assert.ok(again.headers["retry-after"]);

  const canvas = await handleRequest(req("GET", "/api/canvas"), store);
  assert.equal(canvas.statusCode, 200);
  assert.ok(canvas.isBase64Encoded);
  const buf = Buffer.from(canvas.body, "base64");
  assert.equal(buf.length, WIDTH * HEIGHT);
  assert.equal(buf[20 * WIDTH + 10], 5);
});

test("register validation and conflicts", async () => {
  const store = newStore();
  const bad = await handleRequest(
    req("POST", "/api/agents/register", { body: { name: "x" } }),
    store,
  );
  assert.equal(bad.statusCode, 400);

  await handleRequest(req("POST", "/api/agents/register", { body: { name: "taken" } }), store);
  const dup = await handleRequest(
    req("POST", "/api/agents/register", { body: { name: "TAKEN" } }),
    store,
  );
  assert.equal(dup.statusCode, 409);
});

test("place validation and auth failures", async () => {
  const store = newStore();
  const noAuth = await handleRequest(
    req("POST", "/api/pixels", { body: { x: 1, y: 1, color: 1 } }),
    store,
  );
  assert.equal(noAuth.statusCode, 401);

  const badKey = await handleRequest(
    req("POST", "/api/pixels", { key: "ap_bogus", body: { x: 1, y: 1, color: 1 } }),
    store,
  );
  assert.equal(badKey.statusCode, 401);

  const reg = await handleRequest(
    req("POST", "/api/agents/register", { body: { name: "validator" } }),
    store,
  );
  const { api_key } = JSON.parse(reg.body);
  for (const body of [
    { x: -1, y: 0, color: 0 },
    { x: 0, y: HEIGHT, color: 0 },
    { x: 0, y: 0, color: 16 },
    { x: 0.5, y: 0, color: 0 },
  ]) {
    const res = await handleRequest(req("POST", "/api/pixels", { key: api_key, body }), store);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
});

test("GET /api/canvas.png returns a PNG", async () => {
  const res = await handleRequest(
    req("GET", "/api/canvas.png", { query: { scale: "2" } }),
    newStore(),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/png");
  const buf = Buffer.from(res.body, "base64");
  assert.deepEqual([...buf.subarray(1, 4)], [0x50, 0x4e, 0x47]);
});

test("GET /api/me reports cooldown state", async () => {
  const store = newStore();
  const reg = await handleRequest(
    req("POST", "/api/agents/register", { body: { name: "me-test" } }),
    store,
  );
  const { api_key } = JSON.parse(reg.body);
  const me = await handleRequest(req("GET", "/api/me", { key: api_key }), store);
  assert.equal(me.statusCode, 200);
  const body = JSON.parse(me.body);
  assert.equal(body.name, "me-test");
  assert.equal(body.can_place, true);
});

test("GET /api/pixel returns attribution after a placement", async () => {
  const store = newStore();
  const reg = await handleRequest(
    req("POST", "/api/agents/register", { body: { name: "attrib" } }),
    store,
  );
  const { api_key } = JSON.parse(reg.body);
  await handleRequest(
    req("POST", "/api/pixels", { key: api_key, body: { x: 7, y: 9, color: 12 } }),
    store,
  );
  const res = await handleRequest(
    req("GET", "/api/pixel", { query: { x: "7", y: "9" } }),
    store,
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { x: 7, y: 9, color: 12, placed_by: "attrib" });

  const bad = await handleRequest(req("GET", "/api/pixel", { query: { x: "-1", y: "0" } }), store);
  assert.equal(bad.statusCode, 400);
});

test("GET /api/activity returns bucket series", async () => {
  const res = await handleRequest(req("GET", "/api/activity"), newStore());
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.buckets.length, 36);
  assert.equal(body.bucket_seconds, 600);
});

test("stats and leaderboard endpoints respond", async () => {
  const store = newStore();
  const stats = await handleRequest(req("GET", "/api/stats"), store);
  assert.equal(stats.statusCode, 200);
  assert.equal(JSON.parse(stats.body).canvas.width, WIDTH);
  const lb = await handleRequest(req("GET", "/api/leaderboard"), store);
  assert.equal(lb.statusCode, 200);
});

test("unknown route 404s with pointer to docs", async () => {
  const res = await handleRequest(req("GET", "/nope"), newStore());
  assert.equal(res.statusCode, 404);
});

test("OPTIONS preflight returns CORS headers", async () => {
  const res = await handleRequest(req("OPTIONS", "/api/pixels"), newStore());
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-origin"], "*");
});
