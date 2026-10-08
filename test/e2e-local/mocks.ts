// Mock Homies backend (records /settled POSTs, checks X-Fight-Key) + mock
// DIGITVL catalog (one READY track) for the LocalNet e2e harness.
import { Hono } from "hono";
import { serve } from "@hono/node-server";

const KEY = process.env.FIGHT_GATEWAY_SECRET || "e2e-fight-key";
const TRACK = "c4881155-f83d-4bcd-af16-e470906e82a4";
const posts: unknown[] = [];
const app = new Hono();
app.post("/api/:kind/settled", async (c) => {
  const keyOk = c.req.header("x-fight-key") === KEY;
  posts.push({ kind: c.req.param("kind"), keyOk, body: await c.req.json().catch(() => null) });
  return keyOk ? c.json({ ok: true }) : c.json({ error: "bad key" }, 401);
});
app.get("/api/tracks/:id/", (c) =>
  c.req.param("id") === TRACK
    ? c.json({ id: TRACK, title: "EAST", primary_artist_name: "Mwosa", status: "READY", audio_stream_url: "https://example/east.mp3" })
    : c.json({}, 404),
);
app.get("/_posts", (c) => c.json(posts));
serve({ fetch: app.fetch, port: Number(process.env.PORT || 4403) }, (i) => console.log(`mocks :${i.port}`));
