const BASE = process.env.BASE_URL, KEY = process.env.API_KEY;
const doctors = ["Dr Ade", "Dr Okafor", "Dr Bello"];
const slots = [];
const day0 = new Date(); day0.setUTCHours(0, 0, 0, 0);
let n = 1;
for (let d = 1; d <= 3; d++) {
  doctors.forEach((provider, i) => {
    for (let h = 8 + i; h < 11 + i; h++) {
      const s = new Date(day0.getTime() + d * 86400000 + h * 3600000);
      const e = new Date(s.getTime() + 30 * 60000);
      const iso = (x) => x.toISOString().replace(".000", "");
      slots.push({ id: `demo-${n++}`, provider, start: iso(s), end: iso(e) });
    }
  });
}
fetch(BASE + "/reset", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-API-Key": KEY },
  body: JSON.stringify({ slots }),
}).then(async (r) => console.log(r.status, await r.text()));