import { TABLE } from "../src/store.mjs";

// In-memory fake of the DynamoDB document client, emulating only the
// expression patterns the Store uses.
export function fakeDoc() {
  const items = new Map(); // "pk|sk" -> item
  const k = (key) => `${key.pk}|${key.sk}`;
  const condFail = (item) => {
    const err = new Error("conditional");
    err.name = "ConditionalCheckFailedException";
    if (item) {
      err.Item = Object.fromEntries(Object.entries(item).map(([key, v]) => [
        key,
        typeof v === "number" ? { N: String(v) } : { S: String(v) },
      ]));
    }
    return err;
  };
  return {
    items,
    async put(p) {
      const existing = items.get(k(p.Item));
      if (p.ConditionExpression === "attribute_not_exists(pk)" && existing) {
        throw condFail(existing);
      }
      items.set(k(p.Item), { ...p.Item });
      return {};
    },
    async get(p) {
      return { Item: items.get(k(p.Key)) };
    },
    async update(p) {
      const key = k(p.Key);
      const item = items.get(key);
      const v = p.ExpressionAttributeValues || {};
      if (p.UpdateExpression.startsWith("SET last_placed_at")) {
        const ok = item &&
          (item.last_placed_at === undefined || item.last_placed_at <= v[":cutoff"]);
        if (!ok) throw condFail(item);
        item.last_placed_at = v[":now"];
        item.pixels_placed = (item.pixels_placed || 0) + v[":one"];
        return { Attributes: { ...item } };
      }
      if (p.UpdateExpression === "SET px.#i = :c, #o.#i = :n") {
        if (!item || item.px === undefined || item.own === undefined) throw condFail(item);
        item.px[p.ExpressionAttributeNames["#i"]] = v[":c"];
        item.own[p.ExpressionAttributeNames["#i"]] = v[":n"];
        return {};
      }
      if (p.UpdateExpression.startsWith("SET px = if_not_exists")) {
        const cur = item || { ...p.Key };
        if (cur.px === undefined) cur.px = { ...v[":empty"] };
        if (cur.own === undefined) cur.own = { ...v[":empty"] };
        items.set(key, cur);
        return {};
      }
      throw new Error(`fakeDoc: unhandled update ${p.UpdateExpression}`);
    },
    async query(p) {
      const pk = p.ExpressionAttributeValues[":pk"];
      const after = p.ExpressionAttributeValues[":sk"];
      let rows = [...items.values()].filter((i) => i.pk === pk);
      if (after !== undefined) rows = rows.filter((i) => i.sk > after);
      const asc = p.ScanIndexForward === true;
      rows.sort((a, b) => (a.sk < b.sk ? -1 : 1) * (asc ? 1 : -1));
      return { Items: rows.slice(0, p.Limit || rows.length) };
    },
    async scan(p) {
      const prefix = p.ExpressionAttributeValues[":k"];
      return { Items: [...items.values()].filter((i) => i.pk.startsWith(prefix)) };
    },
    async batchGet(p) {
      const keys = p.RequestItems[TABLE].Keys;
      return {
        Responses: { [TABLE]: keys.map((k2) => items.get(`${k2.pk}|${k2.sk}`)).filter(Boolean) },
      };
    },
  };
}
