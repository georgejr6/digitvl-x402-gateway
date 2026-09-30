# DIGITVL x402 Gateway

Pay-per-unlock access to independent artists' music on **DIGITVL**, paid in **USDC on Algorand mainnet** over the **x402** protocol and settled through the **GoPlausible facilitator**.

**Live:** https://digitvl-x402-gateway-production.up.railway.app  
**Demo video (3:25):** https://github.com/georgejr6/digitvl-x402-gateway/releases/download/v1.0/DIGITVL_x402_demo.mp4

| Endpoint | Price | What it does |
|---|---|---|
| `GET /tracks` | free | Browse the catalog (track id, title, artist, genre, duration) |
| `GET /unlock?track_id=<uuid>` | $0.05 USDC | Returns the track's streaming URL after an x402 payment |

## How a request works

1. A client (a fan's app, or an AI agent) calls `GET /unlock?track_id=...`.
2. The gateway answers **HTTP 402** with a `PAYMENT-REQUIRED` challenge: scheme `exact`, network `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=` (mainnet), asset `31566704` (USDC), the artist payout address, and GoPlausible's fee payer, so the payer needs no ALGO for fees.
3. The client signs the USDC transfer and retries with the payment header.
4. The gateway has GoPlausible **verify** (simulates the atomic group) and then **settle** (submits it on-chain), and only then returns the stream URL.

Every route declares **Bazaar discovery** metadata (input/output schema) and the `x402-global-challenge` tag in `extra`, so agents can discover and call it from the GoPlausible Bazaar.

First mainnet settlement: [`X3UK372SRUD7QARXJX66XN4IZHPZVELXMLZTGDZXDBT3WHWNW2AQ`](https://allo.info/tx/X3UK372SRUD7QARXJX66XN4IZHPZVELXMLZTGDZXDBT3WHWNW2AQ) (0.05 USDC, round 65538402).

## Why x402 fits DIGITVL

Streaming platforms pay artists fractions of a cent per play, months later, through layers of intermediaries. With x402 each unlock is a direct USDC payment to the artist's wallet, settled in seconds, with no account, card, or subscription needed. The same endpoint works for people and for AI agents that curate or license music.

## Run it

```bash
npm install
ALGO_PAY_TO_ADDRESS=<payout address> \
DIGITVL_CATALOG_API_KEY=<catalog key> \
FACILITATOR_URL=https://facilitator.goplausible.xyz \
npm start
```

Built on the official x402 v2 packages (`@x402/hono`, `@x402/avm`, `@x402/core`, `@x402-avm/extensions`), following the Algorand Foundation's x402 demo.
