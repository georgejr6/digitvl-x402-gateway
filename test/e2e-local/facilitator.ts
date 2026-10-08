// LocalNet x402 facilitator for the e2e harness: the SAME published
// @x402/avm ExactAvmScheme facilitator code GoPlausible runs, behind the
// standard /supported /verify /settle HTTP API. The network label stays the
// mainnet CAIP-2 (the scheme only accepts mainnet/testnet ids); the signer's
// "mainnet" algod is pointed at LocalNet instead.
//   FACILITATOR_SK (base64 64-byte key)  ALGOD_URL  ALGOD_TOKEN  PORT
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorAvmSigner } from "@x402/avm";
import { ExactAvmScheme } from "@x402/avm/exact/facilitator";

const NETWORK = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const signer = toFacilitatorAvmSigner(process.env.FACILITATOR_SK!, {
  mainnetUrl: process.env.ALGOD_URL || "http://localhost:14001",
  algodToken: process.env.ALGOD_TOKEN || "a".repeat(64),
});
const fac = new x402Facilitator().register(NETWORK, new ExactAvmScheme(signer));
const log: unknown[] = [];
const app = new Hono();
app.get("/supported", (c) => c.json(fac.getSupported()));
app.post("/verify", async (c) => {
  const b = await c.req.json();
  const group = b.paymentPayload?.payload?.paymentGroup?.length;
  try {
    const r = await fac.verify(b.paymentPayload, b.paymentRequirements);
    log.push({ op: "verify", r, group });
    return c.json(r);
  } catch (e) {
    log.push({ op: "verify", r: { threw: String(e) }, group });
    throw e;
  }
});
app.post("/settle", async (c) => {
  const b = await c.req.json();
  const group = b.paymentPayload?.payload?.paymentGroup?.length;
  try {
    const r = await fac.settle(b.paymentPayload, b.paymentRequirements);
    log.push({ op: "settle", r, group });
    return c.json(r);
  } catch (e) {
    log.push({ op: "settle", r: { threw: String(e) }, group });
    throw e;
  }
});
app.get("/_log", (c) => c.json(log));
serve({ fetch: app.fetch, port: Number(process.env.PORT || 4402) }, (i) => console.log(`local facilitator :${i.port} feePayer ${signer.getAddresses()[0]}`));
