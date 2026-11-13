"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!API_KEY) throw new Error("API_KEY environment variable is required");
if (!DATABASE_URL) throw new Error("DATABASE_URL environment variable is required");

const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------- database

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slots (
      id        TEXT PRIMARY KEY,
      provider  TEXT NOT NULL,
      start_raw TEXT NOT NULL,
      end_raw   TEXT NOT NULL,
      start_ts  TIMESTAMPTZ NOT NULL,
      end_ts    TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookings (
      seq        BIGSERIAL UNIQUE,
      id         TEXT PRIMARY KEY,
      slot_id    TEXT NOT NULL,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'confirmed',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- Level 3: the database itself guarantees one confirmed booking per slot.
    CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
      ON bookings (slot_id) WHERE status = 'confirmed';
    CREATE INDEX IF NOT EXISTS bookings_email_seq ON bookings (email, seq);
    CREATE TABLE IF NOT EXISTS idempotency (
      key       TEXT PRIMARY KEY,
      body_hash TEXT NOT NULL,
      status    INT NOT NULL,
      response  JSONB NOT NULL
    );
  `);
}

async function seedDemoSlotsIfEmpty() {
  const { rows } = await pool.query("SELECT 1 FROM slots LIMIT 1");
  if (rows.length) return;
  const providers = ["Dr Ade", "Dr Okafor", "Dr Bello"];
  const out = [];
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);
  let n = 1;
  for (let d = 1; d <= 3; d++) {
    for (const [pi, provider] of providers.entries()) {
      for (let h = 9 + pi; h < 12 + pi; h++) {
        const s = new Date(base.getTime() + d * 86400000 + h * 3600000);
        const e = new Date(s.getTime() + 30 * 60000);
        out.push({ id: `demo-${n++}`, provider, start: s.toISOString().replace(".000", ""), end: e.toISOString().replace(".000", "") });
      }
    }
  }
  await replaceSlots(out);
}

async function replaceSlots(slots) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM bookings");
    await client.query("DELETE FROM slots");
    await client.query("DELETE FROM idempotency");
    if (slots.length) {
      await client.query(
        `INSERT INTO slots (id, provider, start_raw, end_raw, start_ts, end_ts)
         SELECT id, provider, s, e, s::timestamptz, e::timestamptz
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS t(id, provider, s, e)
         ON CONFLICT (id) DO NOTHING`,
        [slots.map((x) => x.id), slots.map((x) => x.provider), slots.map((x) => x.start), slots.map((x) => x.end)]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------- helpers

const attempts = new Map(); // email -> array of attempt timestamps (ms)
const inflight = new Map(); // idempotency key -> Promise<{hash,status,body}>

function bookingJson(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function fail(res, status, message, headers) {
  if (headers) for (const [k, v] of Object.entries(headers)) res.set(k, v);
  return res.status(status).json({ error: message });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "";
}

// Returns seconds to wait if the email is over the limit, otherwise records the attempt.
// Runs synchronously so concurrent requests cannot slip past the counter.
function checkRateLimit(email) {
  const now = Date.now();
  const recent = (attempts.get(email) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    attempts.set(email, recent);
    return Math.max(1, Math.ceil((recent[0] + RATE_WINDOW_MS - now) / 1000));
  }
  recent.push(now);
  attempts.set(email, recent);
  return 0;
}

setInterval(() => {
  const now = Date.now();
  for (const [email, times] of attempts) {
    if (!times.some((t) => now - t < RATE_WINDOW_MS)) attempts.delete(email);
  }
}, 30 * 1000).unref();

// ---------------------------------------------------------------- app

const app = express();
app.disable("x-powered-by");

// Public: the web page and a health check (no API key needed).
const indexTemplate = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
app.get("/", (req, res) => {
  res.type("html").send(indexTemplate.replace("__API_KEY__", API_KEY));
});
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Level 2: every API request needs the key.
app.use((req, res, next) => {
  const given = req.get("X-API-Key") || "";
  const a = Buffer.from(given);
  const b = Buffer.from(API_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail(res, 401, "invalid or missing API key");
  next();
});

app.use(express.json({ limit: "1mb" }));

// Level 1: replace all slots.
app.post("/reset", async (req, res, next) => {
  try {
    const body = req.body;
    if (!body || typeof body !== "object" || !Array.isArray(body.slots)) return fail(res, 400, "slots must be an array");
    const slots = [];
    for (const s of body.slots) {
      if (!s || typeof s !== "object") return fail(res, 400, "each slot must be an object");
      const id = typeof s.id === "number" ? String(s.id) : s.id;
      if (!isNonEmptyString(id) || !isNonEmptyString(s.provider) || !isNonEmptyString(s.start) || !isNonEmptyString(s.end)) {
        return fail(res, 400, "each slot needs id, provider, start and end");
      }
      if (Number.isNaN(Date.parse(s.start)) || Number.isNaN(Date.parse(s.end))) return fail(res, 400, "slot start and end must be ISO 8601 times");
      slots.push({ id, provider: s.provider, start: s.start, end: s.end });
    }
    await replaceSlots(slots);
    attempts.clear();
    res.json({ status: "ok", slots: slots.length });
  } catch (err) {
    next(err);
  }
});

// Level 1: list slots, earliest first.
app.get("/slots", async (req, res, next) => {
  try {
    const params = [];
    let where = "";
    if (typeof req.query.provider === "string") {
      params.push(req.query.provider);
      where = "WHERE s.provider = $1";
    }
    const { rows } = await pool.query(
      `SELECT s.id, s.provider, s.start_raw, s.end_raw,
              NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
       FROM slots s ${where}
       ORDER BY s.start_ts ASC, s.id ASC`,
      params
    );
    res.json({
      slots: rows.map((r) => ({ id: r.id, provider: r.provider, start: r.start_raw, end: r.end_raw, available: r.available })),
    });
  } catch (err) {
    next(err);
  }
});

// Creates the booking. Throws HttpError for any 4xx outcome.
async function createBooking(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const slotId = typeof b.slot_id === "number" ? String(b.slot_id) : b.slot_id;
  if (!isNonEmptyString(slotId)) throw new HttpError(400, "slot_id is required");
  if (!isNonEmptyString(b.name)) throw new HttpError(400, "name is required");
  if (!isNonEmptyString(b.email)) throw new HttpError(400, "email is required");
  const name = b.name.trim();
  const email = b.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, "email is not valid");

  const slot = (await pool.query("SELECT id, start_ts FROM slots WHERE id = $1", [slotId])).rows[0];
  if (!slot) throw new HttpError(404, "slot not found");
  if (new Date(slot.start_ts).getTime() <= Date.now()) throw new HttpError(400, "slot has already started");

  try {
    const { rows } = await pool.query(
      `INSERT INTO bookings (id, slot_id, name, email, status)
       VALUES ($1, $2, $3, $4, 'confirmed') RETURNING *`,
      [crypto.randomUUID(), slot.id, name, email]
    );
    return { status: 201, body: bookingJson(rows[0]) };
  } catch (err) {
    if (err.code === "23505") throw new HttpError(409, "slot is already booked");
    throw err;
  }
}

async function runBooking(body) {
  try {
    return await createBooking(body);
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
    throw err;
  }
}

// Levels 1-5: book a slot.
app.post("/bookings", async (req, res, next) => {
  try {
    const body = req.body;

    // Level 5: count every attempt (failed ones too) per email, before anything else.
    const rawEmail = body && typeof body === "object" ? body.email : undefined;
    if (isNonEmptyString(rawEmail)) {
      const wait = checkRateLimit(rawEmail.trim().toLowerCase());
      if (wait) return fail(res, 429, "too many attempts, try again later", { "Retry-After": String(wait) });
    }

    // Level 4: idempotency.
    const key = req.get("Idempotency-Key");
    if (!key) {
      const out = await runBooking(body);
      return res.status(out.status).json(out.body);
    }

    const hash = crypto.createHash("sha256").update(JSON.stringify(body === undefined ? null : body)).digest("hex");
    const respond = (stored) => {
      if (stored.hash !== hash) return fail(res, 422, "Idempotency-Key was already used with a different request body");
      return res.status(stored.status).json(stored.body);
    };

    // A concurrent request with the same key: wait for the first one to finish.
    if (inflight.has(key)) return respond(await inflight.get(key));

    const work = (async () => {
      const saved = (await pool.query("SELECT body_hash, status, response FROM idempotency WHERE key = $1", [key])).rows[0];
      if (saved) return { hash: saved.body_hash, status: saved.status, body: saved.response };
      const out = await runBooking(body);
      if (out.status < 500) {
        await pool.query(
          "INSERT INTO idempotency (key, body_hash, status, response) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING",
          [key, hash, out.status, JSON.stringify(out.body)]
        );
      }
      return { hash, status: out.status, body: out.body };
    })();
    inflight.set(key, work);
    try {
      return respond(await work);
    } finally {
      inflight.delete(key);
    }
  } catch (err) {
    next(err);
  }
});

// Level 4: a person's bookings, oldest first, cursor-paginated.
app.get("/bookings", async (req, res, next) => {
  try {
    const { email, limit, cursor } = req.query;
    if (!isNonEmptyString(email)) return fail(res, 400, "email is required");

    let lim = 10;
    if (limit !== undefined) {
      if (typeof limit !== "string" || !/^\d+$/.test(limit.trim())) return fail(res, 400, "limit must be an integer from 1 to 50");
      lim = parseInt(limit, 10);
      if (lim < 1 || lim > 50) return fail(res, 400, "limit must be an integer from 1 to 50");
    }

    let after = 0;
    if (cursor !== undefined && cursor !== "") {
      const decoded = typeof cursor === "string" ? Buffer.from(cursor, "base64url").toString("utf8") : "";
      if (!/^\d{1,18}$/.test(decoded)) return fail(res, 400, "invalid cursor");
      after = decoded;
    }

    const { rows } = await pool.query(
      `SELECT * FROM bookings WHERE email = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
      [email.trim().toLowerCase(), after, lim + 1]
    );
    const page = rows.slice(0, lim);
    const next_cursor = rows.length > lim ? Buffer.from(String(page[page.length - 1].seq)).toString("base64url") : null;
    res.json({ bookings: page.map(bookingJson), next_cursor });
  } catch (err) {
    next(err);
  }
});

// Level 1: get one booking.
app.get("/bookings/:id", async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM bookings WHERE id = $1", [req.params.id]);
    if (!rows.length) return fail(res, 404, "booking not found");
    res.json(bookingJson(rows[0]));
  } catch (err) {
    next(err);
  }
});

// Level 3: cancel a booking and free the slot.
app.delete("/bookings/:id", async (req, res, next) => {
  try {
    // Atomic: only one concurrent cancel can flip confirmed -> cancelled.
    const upd = await pool.query(
      "UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed' RETURNING *",
      [req.params.id]
    );
    if (upd.rows.length) return res.json(bookingJson(upd.rows[0]));
    const exists = await pool.query("SELECT 1 FROM bookings WHERE id = $1", [req.params.id]);
    if (!exists.rows.length) return fail(res, 404, "booking not found");
    return fail(res, 409, "booking is already cancelled");
  } catch (err) {
    next(err);
  }
});

app.use((req, res) => fail(res, 404, "not found"));

app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed" || err instanceof SyntaxError) return fail(res, 400, "request body must be valid JSON");
  if (err.type === "entity.too.large") return fail(res, 400, "request body too large");
  console.error(err);
  fail(res, 500, "internal server error");
});

initDb()
  .then(seedDemoSlotsIfEmpty)
  .then(() => app.listen(PORT, () => console.log(`Clinic booking API listening on ${PORT}`)))
  .catch((err) => {
    console.error("Failed to start:", err);
    process.exit(1);
  });
