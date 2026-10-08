// node --test via tsx: `npm test` (offline; builds groups with algokit transact).
import test from "node:test";
import assert from "node:assert/strict";
import {
  Transaction, TransactionType, encodeTransaction, encodeSignedTransaction, groupTransactions,
} from "@algorandfoundation/algokit-utils/transact";
import { Address, getApplicationAddress } from "@algorandfoundation/algokit-utils/common";
import { checkBetPayment, BET_SELECTOR } from "../betGroup.js";

const APP_ID = 1234;
const APP_ADDR = getApplicationAddress(BigInt(APP_ID)).toString();
const BETTOR = new Address(new Uint8Array(32).fill(7));
const OTHER = new Address(new Uint8Array(32).fill(9));
const FEE_PAYER = new Address(new Uint8Array(32).fill(3));
const base = { firstValid: 1n, lastValid: 100n, genesisHash: new Uint8Array(32), genesisId: "mainnet-v1.0" };
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return new Uint8Array(b); };

type BuildOpts = {
  pool?: number; outcome?: number; appId?: number; callSender?: Address; receiver?: string; selector?: string; noCall?: boolean; onComplete?: number;
  order?: ("fee" | "pay" | "call" | "extra")[]; paymentIndex?: number; feeAsAxfer?: boolean; feeOutsideGroup?: boolean;
};
function build(opts: BuildOpts = {}) {
  const fee = opts.feeAsAxfer
    ? new Transaction({ ...base, type: TransactionType.AssetTransfer, sender: FEE_PAYER, fee: 3000n, assetTransfer: { assetId: 31566704n, amount: 0n, receiver: FEE_PAYER } })
    : new Transaction({ ...base, type: TransactionType.Payment, sender: FEE_PAYER, fee: 3000n, payment: { receiver: FEE_PAYER, amount: 0n } });
  const extra = new Transaction({ ...base, type: TransactionType.Payment, sender: BETTOR, fee: 0n, payment: { receiver: OTHER, amount: 1n } });
  const pay = new Transaction({ ...base, type: TransactionType.AssetTransfer, sender: BETTOR, fee: 0n,
    assetTransfer: { assetId: 31566704n, amount: 5_000_000n, receiver: Address.fromString(opts.receiver || APP_ADDR) } });
  const call = new Transaction({ ...base, type: TransactionType.AppCall, sender: opts.callSender || BETTOR, fee: 0n,
    appCall: { appId: BigInt(opts.appId ?? APP_ID), onComplete: opts.onComplete ?? 0,
      args: [new Uint8Array(Buffer.from(opts.selector || BET_SELECTOR, "hex")), u64(opts.pool ?? 1), new Uint8Array([opts.outcome ?? 2])] } as never });
  const byName = { fee, pay, call, extra };
  const order = opts.order || (opts.noCall ? ["fee", "pay"] : ["fee", "pay", "call"]);
  const grouped = groupTransactions(order.filter((n) => !(opts.feeOutsideGroup && n === "fee")).map((n) => byName[n]));
  const txns = order.map((n) => (opts.feeOutsideGroup && n === "fee" ? fee : grouped.shift()!));
  const enc = (t: Transaction, signed: boolean) =>
    Buffer.from(signed ? encodeSignedTransaction({ txn: t, sig: new Uint8Array(64) }) : encodeTransaction(t)).toString("base64");
  const paymentGroup = txns.map((t, i) => enc(t, order[i] !== "fee"));
  const paymentIndex = opts.paymentIndex ?? order.indexOf("pay");
  return Buffer.from(JSON.stringify({ x402Version: 2, payload: { paymentGroup, paymentIndex } })).toString("base64");
}
const want = { appId: APP_ID, appAddress: APP_ADDR, poolId: "1", outcome: 2 };

test("accepts [fee-payer, axfer, bet()] for the requested pool/outcome", () => {
  assert.equal(checkBetPayment(build(), want), null);
});
test("rejects a bare axfer to the app (no bet call: USDC would be stranded)", () => {
  assert.match(String(checkBetPayment(build({ noCall: true }), want)), /must follow/);
});
test("rejects wrong pool / outcome / app / selector / sender / receiver / on-complete", () => {
  assert.match(String(checkBetPayment(build({ pool: 2 }), want)), /pool/);
  assert.match(String(checkBetPayment(build({ outcome: 3 }), want)), /outcome/);
  assert.match(String(checkBetPayment(build({ appId: 999 }), want)), /wrong app/);
  assert.match(String(checkBetPayment(build({ selector: "deadbeef" }), want)), /not a bet/);
  assert.match(String(checkBetPayment(build({ callSender: OTHER }), want)), /payer/);
  assert.match(String(checkBetPayment(build({ receiver: OTHER.toString() }), want)), /pool app/);
  assert.match(String(checkBetPayment(build({ onComplete: 1 }), want)), /NoOp/);
});
test("requires EXACTLY 3 txns [fee-payer, axfer at 1, bet() at 2] in one group", () => {
  // 4 txns: an extra txn after the bet, or before the payment
  assert.match(String(checkBetPayment(build({ order: ["fee", "pay", "call", "extra"] }), want)), /exactly 3/);
  assert.match(String(checkBetPayment(build({ order: ["fee", "extra", "pay", "call"] }), want)), /exactly 3/);
  // 2 txns: no fee-payer
  assert.match(String(checkBetPayment(build({ order: ["pay", "call"] }), want)), /must follow/);
  // wrong positions / paymentIndex
  assert.match(String(checkBetPayment(build({ order: ["pay", "call", "fee"] }), want)), /paymentIndex must be 1/);
  assert.match(String(checkBetPayment(build({ order: ["fee", "call", "pay"] }), want)), /paymentIndex must be 1/);
  assert.match(String(checkBetPayment(build({ paymentIndex: 0 }), want)), /paymentIndex must be 1/);
  assert.match(String(checkBetPayment(build({ paymentIndex: 2 }), want)), /paymentIndex must be 1/);
  // txn 0 must be the fee-payer payment, in the same group
  assert.match(String(checkBetPayment(build({ feeAsAxfer: true }), want)), /fee-payer/);
  assert.match(String(checkBetPayment(build({ feeOutsideGroup: true }), want)), /one group/);
  // [fee, pay, extra] → the txn at index 2 isn't the bet call
  assert.match(String(checkBetPayment(build({ order: ["fee", "pay", "extra"] }), want)), /bet\(\) app call/);
});
test("rejects garbage headers", () => {
  assert.ok(checkBetPayment("not-base64!!", want));
  assert.ok(checkBetPayment(Buffer.from("{}").toString("base64"), want));
});
