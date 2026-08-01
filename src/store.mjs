// DynamoDB persistence. Single table, composite key (pk, sk).
//
// Items:
//   pk=K#<sha256(api_key)>  sk=#   agent record: name, pixels_placed, last_placed_at, created_at
//   pk=N#<name_lower>       sk=#   name uniqueness marker -> key_hash
//   pk=T#<tile>             sk=#   tile: px map { "<index>": colorInt }
//   pk=R                    sk=<ts13>#<rand>  recent placement, ttl 24h
//
// The doc client is injected so tests can stub it.

import { createHash, randomBytes } from "node:crypto";
import {
  TILE_COUNT, COOLDOWN_SECONDS, tileFor, assemble,
} from "./canvas.mjs";

export const TABLE = process.env.TABLE_NAME || "agent-place";

export function hashKey(apiKey) {
  return createHash("sha256").update(apiKey).digest("hex");
}

export function newApiKey() {
  return "ap_" + randomBytes(20).toString("hex");
}

export function validName(name) {
  return typeof name === "string" && /^[A-Za-z0-9_-]{3,32}$/.test(name);
}

export class ConflictError extends Error {}
export class UnauthorizedError extends Error {}
export class CooldownError extends Error {
  constructor(retryAfter, nextAllowedAt) {
    super("cooldown");
    this.retryAfter = retryAfter;
    this.nextAllowedAt = nextAllowedAt;
  }
}

export class Store {
  constructor(doc) {
    this.doc = doc;
    this._cache = new Map(); // key -> { at, value }
  }

  _cached(key, ttlMs) {
    const hit = this._cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    return undefined;
  }

  _setCache(key, value) {
    this._cache.set(key, { at: Date.now(), value });
    return value;
  }

  // Returns { name, api_key }. Throws ConflictError if the name is taken.
  async register(name) {
    const apiKey = newApiKey();
    const keyHash = hashKey(apiKey);
    const now = Date.now();
    try {
      await this.doc.put({
        TableName: TABLE,
        Item: { pk: `N#${name.toLowerCase()}`, sk: "#", key_hash: keyHash, name },
        ConditionExpression: "attribute_not_exists(pk)",
      });
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") throw new ConflictError(name);
      throw err;
    }
    await this.doc.put({
      TableName: TABLE,
      Item: {
        pk: `K#${keyHash}`, sk: "#",
        name, pixels_placed: 0, created_at: now,
      },
    });
    return { name, api_key: apiKey };
  }

  async getAgent(keyHash) {
    const res = await this.doc.get({
      TableName: TABLE,
      Key: { pk: `K#${keyHash}`, sk: "#" },
    });
    return res.Item;
  }

  // Atomically claims a placement slot: enforces cooldown and increments the
  // pixel counter. Returns the agent record. Throws UnauthorizedError or
  // CooldownError.
  async claimPlacement(keyHash, now = Date.now()) {
    const cutoff = now - COOLDOWN_SECONDS * 1000;
    try {
      const res = await this.doc.update({
        TableName: TABLE,
        Key: { pk: `K#${keyHash}`, sk: "#" },
        UpdateExpression: "SET last_placed_at = :now ADD pixels_placed :one",
        ConditionExpression:
          "attribute_exists(pk) AND (attribute_not_exists(last_placed_at) OR last_placed_at <= :cutoff)",
        ExpressionAttributeValues: { ":now": now, ":one": 1, ":cutoff": cutoff },
        ReturnValues: "ALL_NEW",
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      });
      return res.Attributes;
    } catch (err) {
      if (err.name !== "ConditionalCheckFailedException") throw err;
      const old = err.Item; // marshalled attrs when the item existed
      if (!old) throw new UnauthorizedError();
      const last = Number(old.last_placed_at?.N ?? 0);
      const nextAllowedAt = last + COOLDOWN_SECONDS * 1000;
      const retryAfter = Math.max(1, Math.ceil((nextAllowedAt - now) / 1000));
      throw new CooldownError(retryAfter, nextAllowedAt);
    }
  }

  // Writes one pixel with attribution. Self-heals the tile item's maps on
  // first touch.
  async writePixel(x, y, color, name) {
    const { tile, index } = tileFor(x, y);
    const key = { pk: `T#${tile}`, sk: "#" };
    const setPixel = () => this.doc.update({
      TableName: TABLE,
      Key: key,
      UpdateExpression: "SET px.#i = :c, #o.#i = :n",
      ConditionExpression: "attribute_exists(px) AND attribute_exists(#o)",
      ExpressionAttributeNames: { "#i": String(index), "#o": "own" },
      ExpressionAttributeValues: { ":c": color, ":n": name ?? "" },
    });
    try {
      await setPixel();
    } catch (err) {
      if (err.name !== "ConditionalCheckFailedException") throw err;
      try {
        await this.doc.update({
          TableName: TABLE,
          Key: key,
          UpdateExpression: "SET px = if_not_exists(px, :empty), #o = if_not_exists(#o, :empty)",
          ExpressionAttributeNames: { "#o": "own" },
          ExpressionAttributeValues: { ":empty": {} },
        });
      } catch (err2) {
        // Lost the init race to another writer; the maps now exist.
        if (err2.name !== "ConditionalCheckFailedException") throw err2;
      }
      await setPixel();
    }
  }

  // Color + owner of a single pixel.
  async pixelInfo(x, y) {
    const { tile, index } = tileFor(x, y);
    const res = await this.doc.get({
      TableName: TABLE,
      Key: { pk: `T#${tile}`, sk: "#" },
    });
    const item = res.Item || {};
    return {
      x, y,
      color: item.px?.[String(index)] ?? 0,
      placed_by: item.own?.[String(index)] || null,
    };
  }

  async recordRecent(x, y, color, name, now = Date.now()) {
    const sk = `${String(now).padStart(13, "0")}#${randomBytes(3).toString("hex")}`;
    await this.doc.put({
      TableName: TABLE,
      Item: {
        pk: "R", sk, x, y, color, name, ts: now,
        ttl: Math.floor(now / 1000) + 86400,
      },
    });
  }

  async recent(limit = 100) {
    const cached = this._cached("recent", 2000);
    if (cached) return cached;
    const res = await this.doc.query({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": "R" },
      ScanIndexForward: false,
      Limit: limit,
    });
    const items = (res.Items || []).map(({ x, y, color, name, ts }) => ({ x, y, color, name, ts }));
    return this._setCache("recent", items);
  }

  // Full canvas as Uint8Array of palette indices. Cached briefly per instance.
  async canvas() {
    const cached = this._cached("canvas", 2000);
    if (cached) return cached;
    const keys = Array.from({ length: TILE_COUNT }, (_, t) => ({ pk: `T#${t}`, sk: "#" }));
    const tileMaps = new Array(TILE_COUNT).fill(null);
    let request = { [TABLE]: { Keys: keys } };
    // BatchGet returns up to 100 items / 16MB; loop on UnprocessedKeys.
    for (let round = 0; round < 5 && request; round++) {
      const res = await this.doc.batchGet({ RequestItems: request });
      for (const item of res.Responses?.[TABLE] || []) {
        const t = Number(item.pk.slice(2));
        tileMaps[t] = item.px || null;
      }
      const un = res.UnprocessedKeys;
      request = un && Object.keys(un).length ? un : null;
    }
    return this._setCache("canvas", assemble(tileMaps));
  }

  // Placement counts bucketed per 10 minutes over the last 6 hours, from the
  // recent feed (24h TTL).
  async activity(now = Date.now()) {
    const cached = this._cached("activity", 30000);
    if (cached) return cached;
    const BUCKET_MS = 600_000;
    const BUCKETS = 36;
    const horizon = now - BUCKET_MS * BUCKETS;
    const counts = new Array(BUCKETS).fill(0);
    let items = 0;
    let start;
    let scanned = 0;
    do {
      const res = await this.doc.query({
        TableName: TABLE,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": "R" },
        ScanIndexForward: false,
        Limit: 1000,
        ExclusiveStartKey: start,
      });
      for (const it of res.Items || []) {
        items++;
        if (it.ts >= horizon) {
          const b = Math.min(BUCKETS - 1, Math.floor((it.ts - horizon) / BUCKET_MS));
          counts[b]++;
        }
      }
      start = res.LastEvaluatedKey;
      scanned++;
    } while (start && scanned < 5);
    return this._setCache("activity", {
      bucket_seconds: BUCKET_MS / 1000,
      buckets: counts,
      total_24h: items,
    });
  }

  // Top agents by pixels placed, plus totals. Scan is fine at this scale.
  async leaderboard() {
    const cached = this._cached("leaderboard", 10000);
    if (cached) return cached;
    const agents = [];
    let start;
    do {
      const res = await this.doc.scan({
        TableName: TABLE,
        FilterExpression: "begins_with(pk, :k)",
        ExpressionAttributeValues: { ":k": "K#" },
        ProjectionExpression: "#n, pixels_placed, last_placed_at",
        ExpressionAttributeNames: { "#n": "name" },
        ExclusiveStartKey: start,
      });
      agents.push(...(res.Items || []));
      start = res.LastEvaluatedKey;
    } while (start);
    agents.sort((a, b) => (b.pixels_placed || 0) - (a.pixels_placed || 0));
    return this._setCache("leaderboard", {
      agents: agents.slice(0, 25).map((a) => ({
        name: a.name,
        pixels_placed: a.pixels_placed || 0,
      })),
      total_agents: agents.length,
      total_pixels_placed: agents.reduce((s, a) => s + (a.pixels_placed || 0), 0),
    });
  }
}
