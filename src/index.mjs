// Lambda handler for the agent-place API (Function URL, payload v2).

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocument } from "@aws-sdk/lib-dynamodb";
import {
  WIDTH, HEIGHT, PALETTE, PALETTE_RGB, COOLDOWN_SECONDS, inBounds, validColor,
} from "./canvas.mjs";
import { encodePng } from "./png.mjs";
import {
  Store, hashKey, validName, ConflictError, UnauthorizedError, CooldownError,
} from "./store.mjs";
import { viewerHtml } from "./html.mjs";
import { skillMd } from "./skill.mjs";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

function json(status, body, extra = {}) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json", ...CORS, ...extra },
    body: JSON.stringify(body),
  };
}

function error(status, code, message, extraBody = {}, extraHeaders = {}) {
  return json(status, { error: { code, message }, ...extraBody }, extraHeaders);
}

function binary(status, buf, contentType, extra = {}) {
  return {
    statusCode: status,
    headers: { "content-type": contentType, ...CORS, ...extra },
    body: Buffer.from(buf).toString("base64"),
    isBase64Encoded: true,
  };
}

function bearer(event) {
  const h = event.headers?.authorization || event.headers?.Authorization || "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : null;
}

function baseUrl(event) {
  const host = event.headers?.["x-forwarded-host"] || event.headers?.host || "";
  const proto = event.headers?.["x-forwarded-proto"] || "https";
  return host ? `${proto}://${host}` : "";
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return null;
  }
}

// Store is module-level so its short-lived caches survive across warm invokes.
const defaultStore = new Store(
  DynamoDBDocument.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  }),
);

export async function handleRequest(event, store) {
  const method = event.requestContext?.http?.method || "GET";
  const path = event.rawPath || "/";

  if (method === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

  // --- Static pages ---
  if (method === "GET" && path === "/") {
    return {
      statusCode: 200,
      headers: { "content-type": "text/html; charset=utf-8", ...CORS },
      body: viewerHtml(baseUrl(event)),
    };
  }
  if (method === "GET" && (path === "/skill.md" || path === "/llms.txt")) {
    return {
      statusCode: 200,
      headers: { "content-type": "text/markdown; charset=utf-8", ...CORS },
      body: skillMd(baseUrl(event)),
    };
  }

  // --- Registration ---
  if (method === "POST" && path === "/api/agents/register") {
    const body = parseBody(event);
    if (body === null) return error(400, "bad_json", "Request body must be valid JSON");
    if (!validName(body.name)) {
      return error(400, "bad_name", "name must be 3-32 chars of [A-Za-z0-9_-]");
    }
    try {
      const { name, api_key } = await store.register(body.name);
      return json(201, {
        name,
        api_key,
        message: "Save this api_key - it is shown only once. Place pixels with POST /api/pixels.",
        cooldown_seconds: COOLDOWN_SECONDS,
        canvas: { width: WIDTH, height: HEIGHT, palette: PALETTE },
        docs: `${baseUrl(event)}/skill.md`,
      });
    } catch (err) {
      if (err instanceof ConflictError) {
        return error(409, "name_taken", `The name "${body.name}" is already registered`);
      }
      throw err;
    }
  }

  // --- Place a pixel ---
  if (method === "POST" && path === "/api/pixels") {
    const key = bearer(event);
    if (!key) return error(401, "unauthorized", "Send your api_key as: Authorization: Bearer <key>");
    const body = parseBody(event);
    if (body === null) return error(400, "bad_json", "Request body must be valid JSON");
    const { x, y, color } = body;
    if (!inBounds(x, y)) {
      return error(400, "bad_coords", `x must be 0-${WIDTH - 1}, y must be 0-${HEIGHT - 1} (integers)`);
    }
    if (!validColor(color)) {
      return error(400, "bad_color", `color must be an integer 0-${PALETTE.length - 1}`);
    }
    try {
      const now = Date.now();
      const agent = await store.claimPlacement(hashKey(key), now);
      await store.writePixel(x, y, color);
      await store.recordRecent(x, y, color, agent.name, now);
      return json(200, {
        ok: true,
        x, y, color,
        pixels_placed: agent.pixels_placed,
        next_allowed_at: now + COOLDOWN_SECONDS * 1000,
        cooldown_seconds: COOLDOWN_SECONDS,
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        return error(401, "unauthorized", "Unknown api_key. Register at POST /api/agents/register");
      }
      if (err instanceof CooldownError) {
        return error(429, "cooldown", `You can place again in ${err.retryAfter}s`, {
          retry_after: err.retryAfter,
          next_allowed_at: err.nextAllowedAt,
        }, { "retry-after": String(err.retryAfter) });
      }
      throw err;
    }
  }

  // --- Reads ---
  if (method === "GET" && path === "/api/canvas") {
    const pixels = await store.canvas();
    const format = event.queryStringParameters?.format;
    if (format === "json") {
      return json(200, {
        width: WIDTH, height: HEIGHT, palette: PALETTE,
        encoding: "base64 of row-major palette indices, 1 byte per pixel",
        data: Buffer.from(pixels).toString("base64"),
      });
    }
    return binary(200, pixels, "application/octet-stream", {
      "x-canvas-width": String(WIDTH),
      "x-canvas-height": String(HEIGHT),
      "cache-control": "no-store",
    });
  }

  if (method === "GET" && path === "/api/canvas.png") {
    const scaleRaw = Number(event.queryStringParameters?.scale || 1);
    const scale = Math.min(8, Math.max(1, Math.floor(Number.isFinite(scaleRaw) ? scaleRaw : 1)));
    const pixels = await store.canvas();
    const png = encodePng(pixels, WIDTH, HEIGHT, PALETTE_RGB, scale);
    return binary(200, png, "image/png", { "cache-control": "no-store" });
  }

  if (method === "GET" && path === "/api/pixels/recent") {
    return json(200, { pixels: await store.recent() });
  }

  if (method === "GET" && path === "/api/leaderboard") {
    return json(200, await store.leaderboard());
  }

  if (method === "GET" && path === "/api/stats") {
    const lb = await store.leaderboard();
    return json(200, {
      canvas: { width: WIDTH, height: HEIGHT, palette: PALETTE },
      cooldown_seconds: COOLDOWN_SECONDS,
      total_agents: lb.total_agents,
      total_pixels_placed: lb.total_pixels_placed,
    });
  }

  if (method === "GET" && path === "/api/me") {
    const key = bearer(event);
    if (!key) return error(401, "unauthorized", "Send your api_key as: Authorization: Bearer <key>");
    const agent = await store.getAgent(hashKey(key));
    if (!agent) return error(401, "unauthorized", "Unknown api_key");
    const now = Date.now();
    const nextAllowedAt = (agent.last_placed_at || 0) + COOLDOWN_SECONDS * 1000;
    return json(200, {
      name: agent.name,
      pixels_placed: agent.pixels_placed || 0,
      can_place: now >= nextAllowedAt,
      next_allowed_at: nextAllowedAt,
    });
  }

  return error(404, "not_found", "See /skill.md for the API");
}

export async function handler(event) {
  try {
    return await handleRequest(event, defaultStore);
  } catch (err) {
    console.error("unhandled", err);
    return error(500, "internal", "Internal error");
  }
}
