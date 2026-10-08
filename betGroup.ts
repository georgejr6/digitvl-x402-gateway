// Pre-check of a /bet x402 payment before it reaches the facilitator.
//
// The facilitator only verifies the axfer at paymentIndex (asset, amount,
// receiver, signature). A plain x402 client (e.g. one that found /bet in the
// Bazaar) would send just that axfer: the USDC would land in the HomiesPools
// app with NO bet() call, so no bet box is created and the contract has no
// way to ever send it back (stray USDC is not any pool's money). So /bet only
// lets a payment through when the group is EXACTLY 3 txns
//   [0] facilitator fee-payer (pay), [1] axfer bettor->app (paymentIndex 1),
//   [2] bet() app call for the same pool/outcome, from the same sender
// in one group. Contract v2 also rejects bet() in a group bigger than 3. The contract enforces
// everything else (pool open, cap, judge can't bet, ...) and the facilitator
// simulates the whole group, so a bet the contract rejects is never charged.
import { decodeSignedTransaction, decodeTransaction } from "@algorandfoundation/algokit-utils/transact";

// sha512_256("bet(axfer,uint64,uint8)void")[0:4] — same as the ARC-56 JSON.
export const BET_SELECTOR = "ae155af0";

type Decoded = ReturnType<typeof decodeTransaction>;

function decodeOne(b64: string): Decoded | null {
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  try {
    const s = decodeSignedTransaction(bytes);
    if (s.txn?.type && (s.txn.type as string) !== "unknown") return s.txn;
  } catch {
    /* unsigned (facilitator fee payer) */
  }
  try {
    return decodeTransaction(bytes);
  } catch {
    return null;
  }
}

const hex = (b: Uint8Array | undefined) => Buffer.from(b || new Uint8Array()).toString("hex");
const u64hex = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n);
  return b.toString("hex");
};

export type BetGroupExpect = { appId: number; appAddress: string; poolId: string; outcome: number };

// Returns null when OK, else a short reason.
export function checkBetPayment(header: string, want: BetGroupExpect): string | null {
  let payload: { paymentGroup?: unknown; paymentIndex?: unknown };
  try {
    const parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    payload = parsed?.payload ?? {};
  } catch {
    return "unreadable payment header";
  }
  const group = payload.paymentGroup;
  const idx = payload.paymentIndex;
  if (!Array.isArray(group) || !group.every((g) => typeof g === "string")) return "payment group missing";
  if (group.length < 3) return "the bet() app call must follow the payment";
  if (group.length > 3) return "payment group must be exactly 3 txns [fee-payer, payment, bet()]";
  if (idx !== 1) return "paymentIndex must be 1 (the payment right after the fee-payer)";
  const feePayer = decodeOne(group[0] as string);
  const pay = decodeOne(group[1] as string);
  const call = decodeOne(group[2] as string);
  if (!feePayer || !pay || !call) return "undecodable transaction";
  if ((feePayer.type as string) !== "pay") return "txn 0 must be the fee-payer payment";
  if ((pay.type as string) !== "axfer" || !pay.assetTransfer) return "payment is not an asset transfer";
  if (pay.assetTransfer.receiver.toString() !== want.appAddress) return "payment must go to the pool app";
  if ((call.type as string) !== "appl" || !call.appCall) return "the txn after the payment must be the bet() app call";
  const ac = call.appCall;
  if (ac.appId !== BigInt(want.appId)) return "wrong app";
  if (Number(ac.onComplete ?? 0) !== 0) return "bet() must be a NoOp call";
  if (call.sender.toString() !== pay.sender.toString()) return "bet() must be sent by the payer";
  if (call.rekeyTo) return "rekey not allowed";
  const args = ac.args || [];
  if (args.length !== 3 || hex(args[0]) !== BET_SELECTOR) return "not a bet() call";
  if (hex(args[1]) !== u64hex(BigInt(want.poolId))) return "bet() pool doesn't match ?pool";
  if (hex(args[2]) !== Buffer.from([want.outcome]).toString("hex")) return "bet() outcome doesn't match ?outcome";
  if (hex(pay.group) === "" || hex(pay.group) !== hex(call.group) || hex(feePayer.group) !== hex(pay.group)) {
    return "fee-payer, payment and bet() must be one group";
  }
  return null;
}
