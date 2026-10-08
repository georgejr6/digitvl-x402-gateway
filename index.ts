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
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { checkBetPayment } from "./betGroup.js";
import { isPaidRouteAlias } from "./paths.js";

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
// LocalNet e2e harness only (test/e2e-local): a stand-in USDC ASA. Honoured
// ONLY with a loopback FACILITATOR_URL, so a deploy pointed at a real
// facilitator always charges mainnet USDC whatever the env says.
const LOOPBACK_FACILITATOR = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(FACILITATOR_URL);
const TEST_ASSET_ID = LOOPBACK_FACILITATOR && /^[1-9]\d{0,15}$/.test(process.env.X402_TEST_ASSET_ID || "")
  ? (process.env.X402_TEST_ASSET_ID as string)
  : "";
const ASSET_ID = TEST_ASSET_ID || USDC_MAINNET_ASA_ID;
const PRICE = process.env.UNLOCK_PRICE || "$0.05";
const CHALLENGE_TAG = "x402-global-challenge";
// Fight support (thehomies.app/sponsor, was /fight): fans pay a custom amount from their own
// wallet; the settled payment is reported to the Homies backend, which grants
// the perks. Without FIGHT_GATEWAY_SECRET the route still works, nothing is reported.
const HOMIES_SETTLED_URL = process.env.HOMIES_FIGHT_SETTLED_URL || "https://backend.thehomies.app/api/fight/settled";
const FIGHT_KEY = process.env.FIGHT_GATEWAY_SECRET || "";
// Homies Fight Pools (thehomies.app/fight): pari-mutuel USDC bets held by the
// HomiesPools Algorand app. payTo = the app's address; the bettor's own client
// adds the bet() app call to the payment group (see the /bet notes below).
// Off (503) unless both are set.
const POOLS_APP_ID = Number(process.env.POOLS_APP_ID || 0);
const POOLS_APP_ADDRESS = process.env.POOLS_APP_ADDRESS || "";
const POOLS_ENABLED = Number.isSafeInteger(POOLS_APP_ID) && POOLS_APP_ID > 0 && /^[A-Z2-7]{58}$/.test(POOLS_APP_ADDRESS);
const HOMIES_POOLS_SETTLED_URL = process.env.HOMIES_POOLS_SETTLED_URL || "https://backend.thehomies.app/api/pools/settled";
const SUPPORT_MIN = 1;
const SUPPORT_MAX = 500;
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || "https://www.thehomies.app,https://thehomies.app,http://localhost:3000,http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR_URL })).register(
  ALGORAND_MAINNET_CAIP2,
  TEST_ASSET_ID
    ? new ExactAvmScheme().registerMoneyParser(async (amount) => ({
        amount: String(Math.round(Number(amount) * 1e6)),
        asset: TEST_ASSET_ID,
      }))
    : new ExactAvmScheme(),
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

const supportDiscovery = declareDiscoveryExtension({
  input: { amount: "25" },
  inputSchema: {
    properties: {
      amount: { type: "string", description: "USD amount to pay in USDC, 1 to 500, up to 2 decimals" },
      ref: { type: "string", description: "Optional thehomies.app support reference (links the payment to a Homies account)" },
    },
    required: ["amount"],
  },
  output: {
    example: { ok: true, amount_usd: "25.00", message: "Thank you for backing Mwosa's Oct 29 fight and DIGITVL." },
  },
});

const betDiscovery = declareDiscoveryExtension({
  input: { pool: "1", outcome: "0", amount: "10" },
  inputSchema: {
    properties: {
      pool: { type: "string", description: "Homies Fight Pool id (on-chain pool id in the HomiesPools Algorand app)" },
      outcome: { type: "string", description: "Outcome index, 0-7" },
      amount: { type: "string", description: "USD amount to bet in USDC, 1 to 500, up to 2 decimals" },
      ref: { type: "string", description: "thehomies.app bet reference (links the bet to a Homies account)" },
    },
    required: ["pool", "outcome", "amount"],
  },
  output: {
    example: { ok: true, pool: "1", outcome: 0, amount_usd: "10.00", message: "Bet placed. Payouts land in your wallet automatically." },
  },
});

// Query params from the x402 HTTP adapter (used by the price function and hooks).
const queryOf = (adapter: { getUrl(): string } | undefined) => {
  try {
    return new URL(adapter?.getUrl() || "http://x/").searchParams;
  } catch {
    return new URLSearchParams();
  }
};
const parseAmount = (v: string | null | undefined) => {
  if (!v || !/^\d{1,3}(\.\d{1,2})?$/.test(v)) return null;
  const n = Number(v);
  return n >= SUPPORT_MIN && n <= SUPPORT_MAX ? n.toFixed(2) : null;
};
const REF_RE = /^[a-f0-9]{24}\.[A-Za-z0-9_-]{32}$/;
const parsePool = (v: string | null | undefined) => (v && /^[1-9]\d{0,14}$/.test(v) ? v : null);
const parseOutcome = (v: string | null | undefined) => (v && /^[0-7]$/.test(v) ? Number(v) : null);
// "12.34" -> "12340000" (USDC has 6 decimals)
const usdToMicro = (usd: string) => String(Math.round(Number(usd) * 100) * 10_000);

// Report a settled /support payment to Homies. Runs in the background so the
// fan's response isn't held up; retried because a lost report = lost perks
// (the payment itself is already on-chain either way).
async function reportSupport(body: Record<string, unknown>, url = HOMIES_SETTLED_URL, label = "fight") {
  if (!FIGHT_KEY) return;
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Fight-Key": FIGHT_KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (r.ok) return;
      // 400 = the backend looked at it and said no; anything else (401 key
      // mismatch, 404 not deployed yet, 5xx) is worth retrying. The backend's
      // sweeper also finds unreported payments on-chain by the fan's wallet.
      const text = await r.text().catch(() => "");
      console.error(`${label} report`, r.status, text);
      if (r.status === 400) return;
    } catch (e) {
      console.error(`${label} report failed`, (e as Error).message);
    }
    await new Promise((res) => setTimeout(res, 5_000 * 2 ** i));
  }
  console.error(`${label} report gave up`, JSON.stringify(body));
}

server.onAfterSettle(async (ctx) => {
  const tc = ctx.transportContext as { request?: { path?: string; adapter?: { getUrl(): string } } } | undefined;
  if (tc?.request?.path === "/bet" && ctx.result?.success) {
    // ctx.result.transaction = the axfer's tx id (the facilitator returns the
    // id of the txn at paymentIndex). The backend re-verifies the whole group
    // on-chain (axfer + bet app call) before recording anything.
    const ref = queryOf(tc.request.adapter).get("ref") || "";
    if (!REF_RE.test(ref)) return;
    void reportSupport(
      { ref, txId: ctx.result.transaction, payer: ctx.result.payer || "", amountMicro: String(ctx.requirements.amount) },
      HOMIES_POOLS_SETTLED_URL,
      "pools",
    );
    return;
  }
  if (tc?.request?.path !== "/support" || !ctx.result?.success) return;
  const ref = queryOf(tc.request.adapter).get("ref") || "";
  if (!REF_RE.test(ref)) return;
  void reportSupport({
    ref,
    amountMicro: String(ctx.requirements.amount),
    txId: ctx.result.transaction,
    payer: ctx.result.payer || "",
    payTo: ctx.requirements.payTo,
  });
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

// Browser clients (thehomies.app/fight) need to read the x402 headers.
app.use(
  "*",
  cors({
    origin: (o) => (ALLOWED_ORIGINS.includes(o) ? o : null),
    allowMethods: ["GET", "OPTIONS"],
    allowHeaders: ["Content-Type", "PAYMENT-SIGNATURE", "X-PAYMENT"],
    exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"],
    maxAge: 600,
  }),
);

const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0b0b0f"/>' +
  '<text x="32" y="43" font-family="Arial Black,Arial,sans-serif" font-size="30" font-weight="900" text-anchor="middle" fill="#ff2d55">DV</text></svg>';
app.get("/logo.svg", (c) =>
  c.body(LOGO_SVG, 200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" }),
);
app.get("/favicon.ico", (c) => c.redirect("/logo.svg", 301));

// Browsers and crawlers (incl. the facilitator leaderboard, which labels
// merchants from the site's title/logo) get a named page; API clients get JSON.
// People land here from the x402 leaderboard: send them to The Homies, where the
// payments actually happen (thehomies.app/payx, /sponsor).
const SITE_NAME = "DIGITVL × The Homies";
const SITE_DESC =
  "Independent music and direct fan support for The Homies community, paid in USDC on Algorand with x402.";
app.get("/", async (c, next) => {
  const accept = c.req.header("accept") || "";
  if (accept.includes("application/json") && !accept.includes("text/html")) return next();
  const logo = `${new URL(c.req.url).origin.replace(/^http:/, "https:")}/logo.svg`;
  const btn = "display:inline-block;margin:6px 8px 6px 0;padding:14px 22px;border-radius:12px;font-weight:700;text-decoration:none";
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${SITE_NAME}</title>
<meta name="description" content="${SITE_DESC}">
<meta property="og:site_name" content="${SITE_NAME}"><meta property="og:title" content="${SITE_NAME}">
<meta property="og:description" content="${SITE_DESC}"><meta property="og:url" content="https://www.thehomies.app/payx">
<meta property="og:image" content="${logo}"><link rel="icon" href="/logo.svg" type="image/svg+xml">
<link rel="canonical" href="https://www.thehomies.app/payx">
</head><body style="font-family:system-ui,sans-serif;background:#0b0b0f;color:#eee;margin:0;padding:48px 20px">
<main style="max-width:640px;margin:0 auto">
<img src="/logo.svg" alt="" width="56" height="56" style="border-radius:14px">
<h1 style="font-size:34px;margin:18px 0 8px">${SITE_NAME}</h1>
<p style="font-size:17px;line-height:1.5;color:#bbb">${SITE_DESC}</p>
<p style="margin-top:24px">
<a style="${btn};background:#f5b942;color:#000" href="https://www.thehomies.app/payx">Pay with x402 &rarr;</a>
<a style="${btn};border:1px solid #444;color:#eee" href="https://www.thehomies.app">Open The Homies</a>
<a style="${btn};border:1px solid #444;color:#eee" href="https://www.thehomies.app/sponsor">Back Mwosa's Oct 29 fight</a>
</p>
<p style="margin-top:28px;font-size:13px;color:#777">For agents: <a style="color:#999" href="/.well-known/x402">/.well-known/x402</a> · GET /support?amount=&lt;usd&gt; · GET /unlock?track_id=&lt;id&gt;</p>
</main></body></html>`);
});

// Merchant manifest (same shape the top x402 merchants publish): who we are and
// where people should go.
app.get("/.well-known/x402", (c) => {
  const origin = new URL(c.req.url).origin.replace(/^http:/, "https:");
  return c.json({
    version: 1,
    name: SITE_NAME,
    description: SITE_DESC,
    url: "https://www.thehomies.app/payx",
    website: "https://www.thehomies.app",
    image: `${origin}/logo.svg`,
    categories: ["music", "creator-support", "community"],
    resources: [`${origin}/support`, `${origin}/unlock`],
  });
});

app.get("/", (c) =>
  c.json({
    service: "DIGITVL x402 gateway",
    description:
      "Pay-per-unlock streaming access to independent artists' music on DIGITVL. " +
      "Each unlock is a USDC micropayment on Algorand, settled through the GoPlausible x402 facilitator.",
    endpoints: {
      "GET /tracks": "free: browse the catalog",
      "GET /unlock?track_id=<uuid>": `paid (${PRICE} USDC): returns the track's stream URL`,
      "GET /support?amount=<usd>": "paid (custom amount, 1-500 USDC): back Mwosa's Oct 29 fight and the DIGITVL platform",
      "GET /bet?pool=<id>&outcome=<n>&amount=<usd>":
        "paid (1-500 USDC): bet on a Homies Fight Pool; the payment group must include the pool's bet() app call",
    },
    network: ALGORAND_MAINNET_CAIP2,
    asset: ASSET_ID,
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

// Validate before the payment gate so nobody signs for a bad request.
app.use("/support", async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  if (!parseAmount(c.req.query("amount"))) {
    return c.json({ error: `amount must be ${SUPPORT_MIN} to ${SUPPORT_MAX} USD, up to 2 decimals` }, 400);
  }
  const ref = c.req.query("ref");
  if (ref !== undefined && !REF_RE.test(ref)) return c.json({ error: "bad ref" }, 400);
  // Never take a Homies-linked payment we can't report.
  if (ref !== undefined && !FIGHT_KEY) return c.json({ error: "support reporting not configured" }, 503);
  await next();
});

// /bet: validate before the payment gate. Checks that need chain state (pool
// open, outcome < n, cap, judge wallets can't bet) are enforced by the
// contract: the facilitator simulates the whole group in verify, so a bet the
// contract would reject never settles and the bettor isn't charged.
app.use("/bet", async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  if (!POOLS_ENABLED) return c.json({ error: "fight pools are not live yet" }, 503);
  if (!parsePool(c.req.query("pool"))) return c.json({ error: "pool must be a pool id" }, 400);
  if (parseOutcome(c.req.query("outcome")) === null) return c.json({ error: "outcome must be 0 to 7" }, 400);
  if (!parseAmount(c.req.query("amount"))) {
    return c.json({ error: `amount must be ${SUPPORT_MIN} to ${SUPPORT_MAX} USD, up to 2 decimals` }, 400);
  }
  const ref = c.req.query("ref");
  if (ref !== undefined && !REF_RE.test(ref)) return c.json({ error: "bad ref" }, 400);
  if (ref !== undefined && !FIGHT_KEY) return c.json({ error: "bet reporting not configured" }, 503);
  // A payment without the matching bet() call would strand the USDC in the
  // app forever (see betGroup.ts): refuse it before the facilitator settles.
  for (const name of ["PAYMENT-SIGNATURE", "X-PAYMENT"]) {
    const h = c.req.header(name);
    if (!h) continue;
    const why = checkBetPayment(h, {
      appId: POOLS_APP_ID,
      appAddress: POOLS_APP_ADDRESS,
      poolId: parsePool(c.req.query("pool")) as string,
      outcome: parseOutcome(c.req.query("outcome")) as number,
    });
    if (why) return c.json({ error: `bad bet payment: ${why}` }, 400);
  }
  await next();
});

/*
 * How the extra bet() app call travels through x402 — checked in
 * node_modules/@x402/avm 2.28.0 + @x402/core 2.28.0 on 2026-10-03:
 *
 * Resource server (this process; @x402/core server x402ResourceServer.
 * findMatchingRequirements -> paymentRequirementsMatchAccepted): only compares
 * the client's echoed `accepted` with our requirements (core fields deep-equal,
 * our `extra` must be a subset of theirs). It never decodes
 * payload.paymentGroup; the group goes to the facilitator untouched. So the
 * client must echo the 402's accepts[0] exactly (incl. extra appId/poolId/outcome).
 *
 * Facilitator (@x402/avm dist/cjs/exact/facilitator/index.js, ExactAvmScheme,
 * GoPlausible's own package):
 *  - verify(): group size <= 16 (MAX_TRANSACTION_GROUP_SIZE), paymentIndex in
 *    range, one consistent group id across all txns.
 *  - decodeTransactionGroup(): signed txns are kept as-is; UNSIGNED txns are
 *    only allowed when the sender is a facilitator address.
 *  - verifyPaymentTransaction(): checks ONLY the txn at payload.paymentIndex
 *    (axfer, amount == requirements.amount, receiver == payTo, asset ==
 *    requirements.asset, signature matches sender). Other txns aren't inspected.
 *  - prepareSignedGroup(): facilitator-sender txns must pass
 *    verifyFeePayerTransaction (pay, amount 0, receiver = self, no close/rekey,
 *    fee <= 5000 * groupSize) and get signed; every other txn is pushed through
 *    unchanged (`signedTxns.push(decodeTransaction(paymentGroup[i]))`).
 *  - simulateTransactionGroup() runs the WHOLE group (contract logic included);
 *    settle() re-verifies, submits the group atomically, waits for the
 *    paymentIndex txn and returns its id as `transaction`.
 * => [fee-payer (unsigned, facilitator), axfer bettor->app (signed),
 *    appcall bet (signed by the bettor, fee 0)] with paymentIndex = 1 is
 *    supported as-is: no stripping, no rejection. The fee payer txn must cover
 *    the 3 txns (3000 µALGO; the cap is 15000). Caveat: the hosted GoPlausible
 *    facilitator is assumed to run this same published scheme code.
 * Re-checked 2026-10-03: @x402/avm 2.28.0 is npm latest. GoPlausible's own
 * fork (@x402-avm/avm 2.6.1) adds only: every txn's genesis hash must equal
 * the requirement's CAIP-2 hash (hence the full mainnet hash above), no
 * keyreg / rekey / close-to in any txn, flat fee-payer cap 16000. None of
 * that rejects the bet() app call. LocalNet e2e harness: test/e2e-local.
 */
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
            extra: { asset: ASSET_ID, tag: CHALLENGE_TAG },
          },
        ],
        description:
          "DIGITVL: unlock streaming access to an independent artist's track (hip-hop, R&B, afrobeats) for a USDC micropayment on Algorand.",
        mimeType: "application/json",
        extensions: unlockDiscovery,
      },
      "GET /support": {
        accepts: [
          {
            scheme: "exact",
            price: (ctx) => `$${parseAmount(queryOf(ctx.adapter).get("amount")) || "1.00"}`,
            network: ALGORAND_MAINNET_CAIP2,
            payTo: PAY_TO,
            extra: { asset: ASSET_ID, tag: CHALLENGE_TAG },
          },
        ],
        description:
          "DIGITVL fan support: back independent artist Mwosa's Oct 29 fight and the DIGITVL platform with a custom USDC amount on Algorand.",
        mimeType: "application/json",
        extensions: supportDiscovery,
      },
      "GET /bet": {
        accepts: [
          {
            scheme: "exact",
            // AssetAmount form so per-request extra (poolId, outcome) rides
            // along: the AVM parsePrice() keeps price.extra, and the static
            // extra below is merged over it (buildPaymentRequirements).
            price: (ctx) => {
              const q = queryOf(ctx.adapter);
              return {
                amount: usdToMicro(parseAmount(q.get("amount")) || "1.00"),
                asset: ASSET_ID,
                extra: { poolId: parsePool(q.get("pool")) || "0", outcome: parseOutcome(q.get("outcome")) ?? 0 },
              };
            },
            network: ALGORAND_MAINNET_CAIP2,
            // Never actually PAY_TO: the pre-gate 503s unless POOLS_ENABLED.
            payTo: POOLS_APP_ADDRESS || PAY_TO,
            extra: { asset: ASSET_ID, tag: CHALLENGE_TAG, appId: POOLS_APP_ID },
          },
        ],
        description:
          "Homies Fight Pools: bet USDC on a fight outcome in a pool held by a public Algorand smart contract (pari-mutuel, 10% house fee, automatic payouts).",
        mimeType: "application/json",
        extensions: betDiscovery,
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

app.get("/support", (c) =>
  c.json({
    ok: true,
    amount_usd: parseAmount(c.req.query("amount")),
    message: "Thank you for backing Mwosa's Oct 29 fight and DIGITVL.",
    paid_via: "x402 / USDC on Algorand",
  }),
);

app.get("/bet", (c) =>
  c.json({
    ok: true,
    pool: parsePool(c.req.query("pool")),
    outcome: parseOutcome(c.req.query("outcome")),
    amount_usd: parseAmount(c.req.query("amount")),
    app_id: POOLS_APP_ID,
    message: "Bet placed. Payouts land in your wallet automatically.",
    paid_via: "x402 / USDC on Algorand",
  }),
);

const port = Number(process.env.PORT || 4021);
// Railway terminates TLS at its proxy, so the app sees http:// URLs. Restore
// the public scheme so the 402 challenge (and the Bazaar listing built from
// it) advertises the https resource URL.
const fetchWithPublicScheme = (req: Request) => {
  // See paths.ts: only the exact spelling of a paid route gets through.
  if (isPaidRouteAlias(new URL(req.url).pathname)) {
    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }
  if (req.headers.get("x-forwarded-proto") === "https" && req.url.startsWith("http://")) {
    req = new Request(req.url.replace(/^http:/, "https:"), req);
  }
  return app.fetch(req);
};

serve({ fetch: fetchWithPublicScheme, port }, () => console.log(`DIGITVL x402 gateway on :${port}`));
