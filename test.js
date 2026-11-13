"use strict";
// Usage: BASE_URL=http://localhost:3000 API_KEY=secret node test.js
// WARNING: calls POST /reset, which wipes all bookings and slots.

const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const KEY = process.env.API_KEY || "test-key";

let passed = 0;
let failed = 0;

async function call(method, path, { body, headers = {}, key = KEY } = {}) {
  const h = { "Content-Type": "application/json", ...headers };
  if (key !== null) h["X-API-Key"] = key;
  const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch (e) { /* none */ }
  return { status: res.status, data, headers: res.headers };
}

function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
}

const future = (days, hour) => new Date(Date.UTC(2030, 0, days, hour)).toISOString().replace(".000", "");
const slot = (id, provider, days, hour) => ({ id, provider, start: future(days, hour), end: future(days, hour + 1) });

async function reset(slots) {
  return call("POST", "/reset", { body: { slots } });
}

let emailCounter = 0;
const uniqueEmail = () => `user${Date.now()}${emailCounter++}@example.com`;

(async () => {
  console.log("Level 2: API key");
  let r = await call("GET", "/slots", { key: null });
  check("missing key -> 401", r.status === 401 && typeof r.data.error === "string", r);
  r = await call("GET", "/slots", { key: "wrong" });
  check("wrong key -> 401", r.status === 401, r);
  r = await call("POST", "/reset", { key: "wrong", body: { slots: [] } });
  check("reset with wrong key -> 401", r.status === 401, r);

  console.log("Level 1: reset, slots, book, get");
  r = await reset([
    slot("s2", "Dr Okafor", 11, 9),
    slot("s1", "Dr Ade", 10, 9),
    slot("s3", "Dr Ade", 10, 8),
    { id: "past", provider: "Dr Ade", start: "2020-01-01T09:00:00Z", end: "2020-01-01T09:30:00Z" },
  ]);
  check("reset -> 200", r.status === 200, r);
  r = await call("GET", "/slots");
  check("slots earliest first, past included", r.status === 200 && r.data.slots.map((s) => s.id).join() === "past,s3,s1,s2", r.data);
  check("slot keeps original time strings", r.data.slots.find((s) => s.id === "s1").start === future(10, 9));
  check("all available", r.data.slots.every((s) => s.available === true));
  r = await call("GET", "/slots?provider=Dr%20Ade");
  check("provider filter exact", r.data.slots.length === 3 && r.data.slots.every((s) => s.provider === "Dr Ade"), r.data);

  const email = uniqueEmail();
  r = await call("POST", "/bookings", { body: { slot_id: "s1", name: "  Ada Obi ", email: `  ${email.toUpperCase()} ` } });
  check("book -> 201 confirmed", r.status === 201 && r.data.status === "confirmed", r);
  check("name trimmed, email lowercased", r.data.name === "Ada Obi" && r.data.email === email, r.data);
  check("booking has id and created_at", !!r.data.id && !Number.isNaN(Date.parse(r.data.created_at)), r.data);
  const booking = r.data;
  r = await call("GET", `/bookings/${booking.id}`);
  check("get booking -> 200", r.status === 200 && r.data.id === booking.id, r);
  r = await call("GET", "/bookings/nope");
  check("get unknown booking -> 404", r.status === 404 && typeof r.data.error === "string", r);
  r = await call("GET", "/slots");
  check("booked slot unavailable", r.data.slots.find((s) => s.id === "s1").available === false);

  console.log("Level 2: validation");
  const bad = async (name, body, status) => {
    const x = await call("POST", "/bookings", { body });
    check(name, x.status === status && typeof x.data.error === "string", x);
  };
  await bad("missing slot_id -> 400", { name: "A", email: uniqueEmail() }, 400);
  await bad("empty name -> 400", { slot_id: "s2", name: "   ", email: uniqueEmail() }, 400);
  await bad("missing email -> 400", { slot_id: "s2", name: "A" }, 400);
  await bad("invalid email -> 400", { slot_id: "s2", name: "A", email: "not-an-email" }, 400);
  await bad("unknown slot -> 404", { slot_id: "zzz", name: "A", email: uniqueEmail() }, 404);
  await bad("past slot -> 400", { slot_id: "past", name: "A", email: uniqueEmail() }, 400);
  r = await call("POST", "/bookings", { body: "{not json" });
  check("malformed JSON -> 400", r.status === 400 && typeof r.data.error === "string", r);

  console.log("Level 3: double booking and cancel");
  r = await call("POST", "/bookings", { body: { slot_id: "s1", name: "B", email: uniqueEmail() } });
  check("booked slot -> 409", r.status === 409 && typeof r.data.error === "string", r);
  const results = await Promise.all(
    Array.from({ length: 30 }, () => call("POST", "/bookings", { body: { slot_id: "s2", name: "Racer", email: uniqueEmail() } }))
  );
  const wins = results.filter((x) => x.status === 201).length;
  const conflicts = results.filter((x) => x.status === 409).length;
  check("30 simultaneous requests: exactly one 201", wins === 1 && conflicts === 29, { wins, conflicts });
  r = await call("DELETE", `/bookings/${booking.id}`);
  check("cancel -> 200 cancelled", r.status === 200 && r.data.status === "cancelled", r);
  r = await call("DELETE", `/bookings/${booking.id}`);
  check("cancel twice -> 409", r.status === 409, r);
  r = await call("DELETE", "/bookings/nope");
  check("cancel unknown -> 404", r.status === 404, r);
  r = await call("GET", "/slots");
  check("cancelled slot available again", r.data.slots.find((s) => s.id === "s1").available === true);
  r = await call("POST", "/bookings", { body: { slot_id: "s1", name: "C", email: uniqueEmail() } });
  check("rebook freed slot -> 201", r.status === 201, r);

  console.log("Level 4: idempotency");
  const idemEmail = uniqueEmail();
  const idemBody = { slot_id: "s3", name: "Idem", email: idemEmail };
  const first = await call("POST", "/bookings", { body: idemBody, headers: { "Idempotency-Key": "k-1" } });
  const second = await call("POST", "/bookings", { body: idemBody, headers: { "Idempotency-Key": "k-1" } });
  check("first -> 201", first.status === 201, first);
  check("replay -> same status and booking id", second.status === 201 && second.data.id === first.data.id, second);
  r = await call("POST", "/bookings", { body: { ...idemBody, name: "Other" }, headers: { "Idempotency-Key": "k-1" } });
  check("same key, different body -> 422", r.status === 422 && typeof r.data.error === "string", r);
  const parallel = await Promise.all(
    Array.from({ length: 4 }, () => call("POST", "/bookings", { body: { slot_id: "past", name: "P", email: uniqueEmail() }, headers: { "Idempotency-Key": "k-err" } }))
  );
  check("replayed errors keep their status", parallel.every((x) => x.status === 400 || x.status === 422 || x.status === 429), parallel.map((x) => x.status));
  r = await call("GET", `/bookings?email=${encodeURIComponent(idemEmail.toUpperCase())}`);
  check("only one booking despite retries (email match ignores case)", r.status === 200 && r.data.bookings.length === 1, r.data);

  console.log("Level 4: pagination");
  const pageEmail = uniqueEmail();
  const many = Array.from({ length: 7 }, (_, i) => slot(`p${i}`, "Dr Page", 20 + i, 9));
  await reset(many);
  for (let i = 0; i < 5; i++) await call("POST", "/bookings", { body: { slot_id: `p${i}`, name: "Pager", email: pageEmail } });
  // different emails to avoid the rate limit of 5/min for pageEmail
  const pageEmail2 = uniqueEmail();
  await call("POST", "/bookings", { body: { slot_id: "p5", name: "Pager", email: pageEmail } }); // 6th attempt for pageEmail -> 429
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const q = `/bookings?email=${encodeURIComponent(pageEmail)}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    r = await call("GET", q);
    if (r.status !== 200) break;
    seen.push(...r.data.bookings.map((b) => b.slot_id));
    cursor = r.data.next_cursor;
    pages++;
  } while (cursor && pages < 10);
  check("paging walks all bookings oldest first", seen.join() === "p0,p1,p2,p3,p4", seen);
  check("3 pages, last next_cursor null", pages === 3 && cursor === null, { pages, cursor });
  r = await call("GET", `/bookings?email=${pageEmail}&limit=0`);
  check("limit 0 -> 400", r.status === 400, r);
  r = await call("GET", `/bookings?email=${pageEmail}&limit=51`);
  check("limit 51 -> 400", r.status === 400, r);
  r = await call("GET", `/bookings?email=${pageEmail}&limit=abc`);
  check("limit abc -> 400", r.status === 400, r);
  r = await call("GET", `/bookings?email=${pageEmail}&limit=50`);
  check("limit 50 ok, default 10 ok", r.status === 200 && (await call("GET", `/bookings?email=${pageEmail}`)).status === 200);
  r = await call("GET", `/bookings?email=${pageEmail2}`);
  check("unknown person -> empty list, null cursor", r.status === 200 && r.data.bookings.length === 0 && r.data.next_cursor === null, r.data);

  console.log("Level 5: rate limit");
  await reset([slot("r1", "Dr Rate", 5, 9)]);
  const rateEmail = uniqueEmail();
  const statuses = [];
  let last = null;
  for (let i = 0; i < 6; i++) {
    last = await call("POST", "/bookings", { body: { slot_id: i === 0 ? "r1" : "missing", name: "Spam", email: rateEmail } });
    statuses.push(last.status);
  }
  check("first 5 attempts allowed (201 then 404s)", statuses.slice(0, 5).join() === "201,404,404,404,404", statuses);
  check("6th -> 429", statuses[5] === 429 && typeof last.data.error === "string", last);
  const ra = last.headers.get("Retry-After");
  check("Retry-After is whole seconds (1-60)", /^\d+$/.test(ra || "") && +ra >= 1 && +ra <= 60, ra);
  r = await call("POST", "/bookings", { body: { slot_id: "missing", name: "Other", email: uniqueEmail() } });
  check("other emails unaffected", r.status === 404, r);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
