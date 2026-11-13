# Clinic booking API

Express + Postgres API and a single-page web UI for the Koya Cohort 4 assessment (Task 1).
The web page is served from the same app at `/`.

## Run locally

```bash
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/clinic
export API_KEY=choose-a-long-random-string
npm start            # http://localhost:3000
npm test             # runs against BASE_URL (default http://localhost:3000); wipes data
```

Tables are created on startup. If there are no slots, a few demo slots are seeded.

## Environment variables

| Name | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (Neon works as-is) |
| `API_KEY` | Value clients must send in `X-API-Key` |
| `PORT` | Set automatically by Render |

## How each level is met

- **Level 1:** `POST /reset`, `GET /slots`, `POST /bookings`, `GET /bookings/{id}`. Slot times are returned exactly as sent.
- **Level 2:** `X-API-Key` checked on every API route (401). Validation, trimming, lowercase email, 404 unknown slot, 400 started slot.
- **Level 3:** a partial unique index (`slot_id` where `status = 'confirmed'`) means the database refuses a second confirmed booking, so simultaneous requests can't both win (409 for the rest). `DELETE /bookings/{id}` cancels atomically and frees the slot; a second cancel is 409.
- **Level 4:** `Idempotency-Key` stores a hash of the body and the original response in Postgres. Same key and body replays the stored status and booking; a different body is 422. Concurrent requests with the same key wait for the first one. `GET /bookings?email=&limit=&cursor=` uses cursor pagination (oldest first, `limit` 1-50, case-insensitive email).
- **Level 5:** at most 5 `POST /bookings` attempts per email per minute, failed attempts included. The 6th returns 429 with `Retry-After` in whole seconds. The counter is in memory and checked synchronously, so it holds under concurrency on a single instance.

## Notes and assumptions

- `available` on a slot means "has no confirmed booking". Past slots are still listed; they just can't be booked.
- `POST /reset` also clears idempotency records and rate-limit counters.
- `GET /` serves the web page with the API key injected so it works out of the box. That is fine for this assessment but not something to do in production.
- `GET /health` needs no key (useful for uptime pings).

## Deploy (Neon + Render)

1. Neon: create a project and copy the connection string.
2. Push this folder to GitHub.
3. Render: New > Web Service > connect the repo. Build `npm install`, start `npm start`. Add `DATABASE_URL` and `API_KEY` env vars.
4. Smoke test: `BASE_URL=https://your-app.onrender.com API_KEY=... npm test`, then re-seed nothing by hand; the graders call `/reset` themselves.
5. Render's free plan sleeps after ~15 minutes idle. Ping `/health` every 5 minutes with a free monitor (for example UptimeRobot) so graders never hit a cold start.
