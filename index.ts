// DIGITVL x402 gateway: pay-per-unlock access to the DIGITVL music catalog,
// settled in USDC on Algorand mainnet through the GoPlausible facilitator.
// Built on the official x402 v2 packages so the 402 challenge, the
// facilitator verify/settle calls and the Bazaar discovery listing all use
// the exact wire format GoPlausible expects.
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402-avm/extensions";
import type { ResourceServerExtension } from "@x402/core/types";
import { USDC_MAINNET_ASA_ID } from "@x402/avm";
// Full-length CAIP-2 id: GoPlausible advertises and lists Algorand mainnet
// under the complete genesis hash, not the 32-char truncated form.
const ALGORAND_MAINNET_CAIP2 = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
import { Hono } from "hono";
import { serve } from "@hono/node-server";

const need = (k: string) => {
  const v = process.env[k];
  if (!v) {
    console.error(`Missing ${k}`);
    process.exit(1);
  }
  return v;
};

const PAY_TO = need("ALGO_PAY_TO_ADDRESS");
const CATALOG_URL = (process.env.DIGITVL_CATALOG_API_URL || "https://web-production-b04ca.up.railway.app/api").replace(/\/+$/, "");
const CATALOG_KEY = need("DIGITVL_CATALOG_API_KEY");
const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://facilitator.goplausible.xyz";
const PRICE = process.env.UNLOCK_PRICE || "$0.05";
const CHALLENGE_TAG = "x402-global-challenge";

const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR_URL })).register(
  ALGORAND_MAINNET_CAIP2,
  new ExactAvmScheme(),
);
server.registerExtension(bazaarResourceServerExtension as unknown as ResourceServerExtension);

const unlockDiscovery = declareDiscoveryExtension({
  input: { track_id: "c4881155-f83d-4bcd-af16-e470906e82a4" },
  inputSchema: {
    properties: {
      track_id: { type: "string", description: "DIGITVL track UUID (list them free at GET /tracks)" },
    },
    required: ["track_id"],
  },
  output: {
    example: {
      track_id: "c4881155-f83d-4bcd-af16-e470906e82a4",
      title: "EAST",
      artist: "Mwosa",
      genre: "Hip-Hop & Trap",
      duration_seconds: 194.77,
      stream_url: "https://...",
      mime_type: "audio/mpeg",
      paid_via: "x402 / USDC on Algorand",
    },
  },
});

type Track = {
  id: string;
  title: string;
  primary_artist_name?: string;
  genre?: string;
  duration_seconds?: number;
  status?: string;
  audio_stream_url?: string;
};

async function catalog<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${CATALOG_URL}${path}`, {
      headers: { "X-Internal-Api-Key": CATALOG_KEY },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const app = new Hono();

app.get("/", (c) =>
  c.json({
    service: "DIGITVL x402 gateway",
    description:
      "Pay-per-unlock streaming access to independent artists' music on DIGITVL. " +
      "Each unlock is a USDC micropayment on Algorand, settled through the GoPlausible x402 facilitator.",
    endpoints: {
      "GET /tracks": "free: browse the catalog",
      "GET /unlock?track_id=<uuid>": `paid (${PRICE} USDC): returns the track's stream URL`,
    },
    network: ALGORAND_MAINNET_CAIP2,
    asset: USDC_MAINNET_ASA_ID,
  }),
);

app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/tracks", async (c) => {
  const page = Math.max(1, Number(c.req.query("page") || 1) || 1);
  const data = await catalog<{ count: number; next: string | null; results: Track[] }>(`/tracks/?page=${page}`);
  if (!data) return c.json({ error: "catalog unavailable" }, 503);
  return c.json({
    count: data.count,
    page,
    has_more: !!data.next,
    tracks: data.results
      .filter((t) => t.status === "READY")
      .map((t) => ({
        track_id: t.id,
        title: t.title,
        artist: t.primary_artist_name,
        genre: t.genre,
        duration_seconds: t.duration_seconds,
      })),
  });
});

// Reject bad input before the payment gate, so nobody pays for a track that
// doesn't exist.
app.use("/unlock", async (c, next) => {
  const id = c.req.query("track_id") || "";
  if (!UUID.test(id)) return c.json({ error: "track_id must be a DIGITVL track UUID (see GET /tracks)" }, 400);
  const t = await catalog<Track>(`/tracks/${id}/`);
  if (!t || t.status !== "READY" || !t.audio_stream_url) return c.json({ error: "track not found" }, 404);
  c.set("track" as never, t as never);
  await next();
});

app.use(
  paymentMiddleware(
    {
      "GET /unlock": {
        accepts: [
          {
            scheme: "exact",
            price: PRICE,
            network: ALGORAND_MAINNET_CAIP2,
            payTo: PAY_TO,
            extra: { asset: USDC_MAINNET_ASA_ID, tag: CHALLENGE_TAG },
          },
        ],
        description:
          "DIGITVL: unlock streaming access to an independent artist's track (hip-hop, R&B, afrobeats) for a USDC micropayment on Algorand.",
        mimeType: "application/json",
        extensions: unlockDiscovery,
      },
    },
    server,
  ),
);

app.get("/unlock", (c) => {
  const t = c.get("track" as never) as unknown as Track;
  return c.json({
    track_id: t.id,
    title: t.title,
    artist: t.primary_artist_name,
    genre: t.genre,
    duration_seconds: t.duration_seconds,
    stream_url: t.audio_stream_url,
    mime_type: "audio/mpeg",
    paid_via: "x402 / USDC on Algorand",
  });
});

const port = Number(process.env.PORT || 4021);
// Railway terminates TLS at its proxy, so the app sees http:// URLs. Restore
// the public scheme so the 402 challenge (and the Bazaar listing built from
// it) advertises the https resource URL.
const fetchWithPublicScheme = (req: Request) => {
  if (req.headers.get("x-forwarded-proto") === "https" && req.url.startsWith("http://")) {
    req = new Request(req.url.replace(/^http:/, "https:"), req);
  }
  return app.fetch(req);
};

serve({ fetch: fetchWithPublicScheme, port }, () => console.log(`DIGITVL x402 gateway on :${port}`));
