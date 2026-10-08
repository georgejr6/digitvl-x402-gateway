// LocalNet e2e: the real frontend client (thehomieshub-front poolPay.js) ->
// this gateway's /bet -> local @x402/avm facilitator (facilitator.ts) ->
// AlgoKit LocalNet; backend report checked against mocks.ts.
// Run: tunnel algod :14001 / kmd :14002 / indexer :18980; deploy a test
// "USDC" ASA + HomiesPools app + pool (env.json: usdc, app, appAddr, pool,
// accts{house,judge,bettor,plain,facil,feerecv: {addr, sk(base64)}}); start
// facilitator.ts (:4402, FACILITATOR_SK=facil.sk), mocks.ts (:4403), and
// index.ts on :4421 with FACILITATOR_URL=http://127.0.0.1:4402
// X402_TEST_ASSET_ID=<usdc> POOLS_APP_ID/ADDRESS, FIGHT_GATEWAY_SECRET=e2e-fight-key,
// DIGITVL_CATALOG_API_URL and HOMIES_*_SETTLED_URL -> :4403. Then copy this
// file to thehomieshub-front/src/lib/pools/ and run
//   E2E_ENV=env.json E2E_OUT=results.json npx vitest run <file> --testTimeout=120000
import fs from 'node:fs';
import algosdk from 'algosdk';
import { describe, expect, it, vi } from 'vitest';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { ExactAvmScheme as StockClient } from '@x402/avm/exact/client';
import { toClientAvmSigner } from '@x402/avm';

const ENV = JSON.parse(fs.readFileSync(process.env.E2E_ENV, 'utf8'));
const ALGOD = new algosdk.Algodv2('a'.repeat(64), 'http://localhost', 14001);
const IDX = 'http://localhost:18980';
const GW = 'http://localhost:4421';
const FAC = 'http://localhost:4402';
const MOCK = 'http://localhost:4403';
const NETWORK = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';

vi.mock('./chain', async (orig) => {
  const real = await orig();
  const env = JSON.parse((await import('node:fs')).readFileSync(process.env.E2E_ENV, 'utf8'));
  const a = new (await import('algosdk')).default.Algodv2('a'.repeat(64), 'http://localhost', 14001);
  return {
    ...real,
    USDC_ASA: env.usdc,
    suggestedParams: async (rounds = 100) => {
      const sp = await a.getTransactionParams().do();
      return { ...sp, lastValid: BigInt(sp.firstValid) + BigInt(rounds) };
    },
  };
});

const { payPoolBet } = await import('./poolPay');
const { betBoxName } = await import('./chain');

const acct = (n) => ({ addr: ENV.accts[n].addr, sk: new Uint8Array(Buffer.from(ENV.accts[n].sk, 'base64')) });
const bettor = acct('bettor');
const plain = acct('plain');
const facil = ENV.accts.facil.addr;
const APP = ENV.app;
const POOL = ENV.pool;
const REF = 'a'.repeat(24) + '.' + 'B'.repeat(32);

const signTransactions = async ([group]) =>
  group.filter((g) => g.signers.length).map((g) => g.txn.signTxn(bettor.sk));

// Record every payment header the client sends (for replay).
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const h = init?.headers || {};
  const sig = h['PAYMENT-SIGNATURE'] || h['payment-signature'];
  if (sig) sent.push({ url: String(url), sig });
  return realFetch(url, init);
};

const j = async (u) => (await realFetch(u)).json();
const usdc = async (addr) => {
  try { return Number((await ALGOD.accountAssetInformation(addr, ENV.usdc).do()).assetHolding.amount); } catch { return -1; }
};
const facLog = () => j(`${FAC}/_log`);
const decodeReq = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
const gw = (q, headers) => realFetch(`${GW}/bet?${q}`, { headers });
const results = [];
// Wallet-style ClientAvmSigner (what use-wallet/Pera give the stock client).
const walletSigner = (a) => ({
  address: a.addr,
  signTransactions: async (txns, idx) => txns.map((t, i) => {
    const txn = algosdk.decodeUnsignedTransaction(t);
    return (!idx || idx.includes(i)) && txn.sender.toString() === a.addr ? txn.signTxn(a.sk) : null;
  }),
});
const rec = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(pass ? 'PASS' : 'FAIL', name, detail); expect(pass, `${name}: ${detail}`).toBe(true); };

describe('LocalNet x402 /bet e2e', () => {
  let first;
  it('402 requirement echo', async () => {
    const r = await gw(`pool=${POOL}&outcome=1&amount=5&ref=${REF}`);
    const req = decodeReq(r.headers.get('payment-required')).accepts[0];
    const ok = r.status === 402 && req.amount === '5000000' && req.asset === String(ENV.usdc) && req.payTo === ENV.appAddr
      && req.extra.appId === APP && String(req.extra.poolId) === String(POOL) && req.extra.outcome === 1 && req.extra.feePayer === facil;
    rec('402 echo', ok, JSON.stringify(req.extra));
    expect(ok).toBe(true);
  });

  it('happy path: real poolPay.js -> settle -> contract + backend report', async () => {
    const appBefore = await usdc(ENV.appAddr);
    const bBefore = await usdc(bettor.addr);
    first = await payPoolBet(`${GW}/bet?pool=${POOL}&outcome=1&amount=5&ref=${REF}`, {
      address: bettor.addr, signTransactions, poolId: POOL, outcome: 1, amountMicro: 5_000_000, appId: APP,
    });
    const appAfter = await usdc(ENV.appAddr);
    const bAfter = await usdc(bettor.addr);
    const box = await ALGOD.getApplicationBoxByName(APP, betBoxName(POOL, bettor.addr)).do();
    rec('happy: body ok + txId', first.body?.ok === true && !!first.txId, first.txId);
    rec('happy: USDC moved bettor->app', appAfter - appBefore === 5_000_000 && bBefore - bAfter === 5_000_000, `${appBefore}->${appAfter}`);
    rec('happy: bet box created', box.value.length > 0, Buffer.from(box.value).toString('hex'));
    // fee payer covered the group
    const info = await ALGOD.pendingTransactionInformation(first.txId).do();
    const blk = await j(`${IDX}/v2/blocks/${info.confirmedRound}`);
    await new Promise((r) => setTimeout(r, 1500));
    const txs = (await j(`${IDX}/v2/blocks/${info.confirmedRound}`)).transactions || blk.transactions || [];
    const pay = txs.find((t) => t.id === first.txId);
    const grp = txs.filter((t) => t.group && t.group === pay?.group);
    const fees = grp.map((t) => `${t['tx-type']}:${t.sender === facil ? 'fac' : t.sender === bettor.addr ? 'bettor' : '?'}:${t.fee}`);
    const feeOk = grp.length === 3 && grp.find((t) => t.sender === facil)?.fee >= 3000 && grp.filter((t) => t.sender === bettor.addr).every((t) => t.fee === 0);
    rec('fee payer covers 3 txns', feeOk, fees.join(' '));
    await new Promise((r) => setTimeout(r, 1500));
    const posts = (await j(`${MOCK}/_posts`)).filter((p) => p.kind === 'pools');
    const p = posts.at(-1);
    rec('onAfterSettle -> backend /pools/settled', !!p && p.keyOk && p.body.txId === first.txId && p.body.ref === REF
      && p.body.payer === bettor.addr && p.body.amountMicro === '5000000', JSON.stringify(p));
  });

  it('replay of the same payment header is rejected', async () => {
    const hdr = sent.at(-1);
    const postsBefore = (await j(`${MOCK}/_posts`)).length;
    const appBefore = await usdc(ENV.appAddr);
    const r = await realFetch(hdr.url, { headers: { 'PAYMENT-SIGNATURE': hdr.sig } });
    const body = await r.text();
    const appAfter = await usdc(ENV.appAddr);
    await new Promise((res) => setTimeout(res, 1500));
    const postsAfter = (await j(`${MOCK}/_posts`)).length;
    // Protection comes from Algorand (same txId can't land twice; it also expires
    // after lastValid) surfacing as a failed facilitator simulate. No re-report.
    rec('replay rejected', !r.ok && appAfter === appBefore && postsAfter === postsBefore, `${r.status} ${body.slice(0, 160)} ${r.headers.get('payment-response') ? JSON.stringify(decodeReq(r.headers.get('payment-response'))) : ''}`);
  });

  it('plain x402 client (no bet call) is rejected before settle', async () => {
    const logBefore = (await facLog()).length;
    const before = await usdc(plain.addr);
    const signer = walletSigner(plain);
    const client = x402Client.fromConfig({ schemes: [{ network: NETWORK, client: new StockClient(signer, { algodUrl: 'http://localhost:14001', algodToken: 'a'.repeat(64) }) }], spendControls: { allowedAssets: true } });
    const http = new x402HTTPClient(client);
    const url = `${GW}/bet?pool=${POOL}&outcome=1&amount=2`;
    const r1 = await realFetch(url);
    const required = http.getPaymentRequiredResponse((h) => r1.headers.get(h), await r1.json());
    const payload = await http.createPaymentPayload(required);
    const r2 = await realFetch(url, { headers: http.encodePaymentSignatureHeader(payload) });
    const body = await r2.text();
    const logAfter = (await facLog()).length;
    const after = await usdc(plain.addr);
    rec('plain client rejected pre-settle', r2.status === 400 && logAfter === logBefore && after === before,
      `${r2.status} ${body} groupLen=${payload.payload.paymentGroup.length} facCalls+${logAfter - logBefore}`);
  });

  for (const variant of ['/bet/', '//bet', '/BET', '/%62et']) it(`plain client via path variant ${variant}`, async () => {
    const before = await usdc(plain.addr);
    const appBefore = await usdc(ENV.appAddr);
    const http = new x402HTTPClient(x402Client.fromConfig({ schemes: [{ network: NETWORK, client: new StockClient(walletSigner(plain), { algodUrl: 'http://localhost:14001', algodToken: 'a'.repeat(64) }) }], spendControls: { allowedAssets: true } }));
    const url = `${GW}${variant}?pool=${POOL}&outcome=1&amount=1`;
    const r1 = await realFetch(url);
    let status = r1.status, body = '';
    if (r1.status === 402) {
      const required = http.getPaymentRequiredResponse((h) => r1.headers.get(h), await r1.json());
      const payload = await http.createPaymentPayload(required);
      const r2 = await realFetch(url, { headers: http.encodePaymentSignatureHeader(payload) });
      status = r2.status; body = await r2.text();
    } else body = await r1.text();
    const after = await usdc(plain.addr);
    const appAfter = await usdc(ENV.appAddr);
    rec(`path variant ${variant} cannot strand USDC`, after === before && appAfter === appBefore, `first=${r1.status} final=${status} ${body.slice(0, 100)} plainDelta=${after - before} appDelta=${appAfter - appBefore}`);
  });

  it('mismatched pool/outcome/amount/sender rejected', async () => {
    // Build a correct header for pool/outcome 1/amount 3 via poolPay (capture only, using a fetch stub).
    const base = `pool=${POOL}&outcome=1&amount=3`;
    const r1 = await gw(base);
    const required = decodeReq(r1.headers.get('payment-required'));
    const { PoolBetScheme } = await import('./poolPay');
    const mk = async (over = {}) => {
      const s = new PoolBetScheme({ address: bettor.addr, signTransactions: over.sign || signTransactions, poolId: over.pool ?? POOL, outcome: over.outcome ?? 1, amountMicro: over.amount ?? 3_000_000, appId: APP });
      const req = { ...required.accepts[0], amount: String(over.amount ?? 3_000_000), extra: { ...required.accepts[0].extra, poolId: over.pool ?? POOL, outcome: over.outcome ?? 1 } };
      const p = await s.createPaymentPayload(2, req);
      const full = { ...p, resource: required.resource, accepted: over.accepted || required.accepts[0] };
      return Buffer.from(JSON.stringify(full)).toString('base64');
    };
    const logBefore = (await facLog()).length;
    const appBefore = await usdc(ENV.appAddr);
    const cases = [];
    const tryIt = async (name, q, hdr) => {
      const r = await gw(q, { 'PAYMENT-SIGNATURE': hdr });
      const t = await r.text();
      let pr = '';
      try { pr = decodeReq(r.headers.get('payment-required') || '').error || ''; } catch { /* none */ }
      cases.push({ name, status: r.status, msg: (t + ' ' + pr).slice(0, 140) });
    };
    const good = await mk();
    await tryIt('outcome mismatch (header outcome 1, url outcome 2)', `pool=${POOL}&outcome=2&amount=3`, good);
    await tryIt('pool mismatch (url pool 9)', `pool=9&outcome=1&amount=3`, good);
    await tryIt('amount mismatch (url amount 4)', `pool=${POOL}&outcome=1&amount=4`, good);
    // group bet() outcome 2 but echoed accepted says outcome 1
    await tryIt('bet() outcome != accepted', base, await mk({ outcome: 2, accepted: required.accepts[0] }));
    // axfer amount 2 USDC vs requirement 3 (accepted echoed as 3)
    await tryIt('axfer amount != requirement', base, await mk({ amount: 2_000_000, accepted: required.accepts[0] }));
    // sender mismatch: appl signed by another account
    const otherSign = async ([group]) => group.filter((g) => g.signers.length).map((g, i) => g.txn.signTxn(bettor.sk));
    {
      const s = new PoolBetScheme({ address: bettor.addr, signTransactions: otherSign, poolId: POOL, outcome: 1, amountMicro: 3_000_000, appId: APP });
      const p = await s.createPaymentPayload(2, { ...required.accepts[0] });
      // swap the appl for one sent by `plain`, regrouped
      const txns = p.payload.paymentGroup.map((b) => { try { return algosdk.decodeSignedTransaction(Buffer.from(b, 'base64')).txn; } catch { return algosdk.decodeUnsignedTransaction(Buffer.from(b, 'base64')); } });
      const appl = txns[2];
      const sp = { fee: 0n, flatFee: true, firstValid: appl.firstValid, lastValid: appl.lastValid, genesisHash: appl.genesisHash, genesisID: appl.genesisID, minFee: 1000n };
      const appl2 = algosdk.makeApplicationNoOpTxnFromObject({ sender: plain.addr, appIndex: APP, appArgs: appl.applicationCall.appArgs, boxes: appl.applicationCall.boxes.map((b) => ({ appIndex: APP, name: b.name })), suggestedParams: sp });
      const fee = algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: facil, receiver: facil, amount: 0, suggestedParams: { ...sp, fee: 3000n } });
      const ax = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: bettor.addr, receiver: ENV.appAddr, assetIndex: ENV.usdc, amount: 3_000_000n, suggestedParams: sp });
      algosdk.assignGroupID([fee, ax, appl2]);
      const grp = [Buffer.from(algosdk.encodeUnsignedTransaction(fee)).toString('base64'), Buffer.from(ax.signTxn(bettor.sk)).toString('base64'), Buffer.from(appl2.signTxn(plain.sk)).toString('base64')];
      const hdr = Buffer.from(JSON.stringify({ x402Version: 2, resource: required.resource, accepted: required.accepts[0], payload: { paymentGroup: grp, paymentIndex: 1 } })).toString('base64');
      await tryIt('bet() sender != payer', base, hdr);
    }
    const logAfter = await facLog();
    const appAfter = await usdc(ENV.appAddr);
    for (const c of cases) rec(`mismatch: ${c.name}`, c.status === 400 || c.status === 402, `${c.status} ${c.msg}`);
    rec('mismatch: no funds moved, no settle', appAfter === appBefore && !logAfter.slice(logBefore).some((e) => e.op === 'settle' && e.r.success),
      `facCalls+${logAfter.length - logBefore} ${JSON.stringify(logAfter.slice(logBefore).map((e) => e.op + ':' + (e.r.invalidReason || e.r.errorReason || e.r.isValid || e.r.success)))}`);
  });

  it('/support and /unlock still work (stock x402 client)', async () => {
    const signer = walletSigner(plain);
    const mkHttp = () => new x402HTTPClient(x402Client.fromConfig({ schemes: [{ network: NETWORK, client: new StockClient(signer, { algodUrl: 'http://localhost:14001', algodToken: 'a'.repeat(64) }) }], spendControls: { allowedAssets: true } }));
    for (const [name, url] of [['support', `${GW}/support?amount=2&ref=${REF}`], ['unlock', `${GW}/unlock?track_id=c4881155-f83d-4bcd-af16-e470906e82a4`]]) {
      const http = mkHttp();
      const before = await usdc(ENV.accts.house.addr);
      const r1 = await realFetch(url);
      const required = http.getPaymentRequiredResponse((h) => r1.headers.get(h), await r1.json());
      const payload = await http.createPaymentPayload(required);
      const r2 = await realFetch(url, { headers: http.encodePaymentSignatureHeader(payload) });
      const body = await r2.json().catch(() => null);
      const after = await usdc(ENV.accts.house.addr);
      rec(`${name} settles`, r2.status === 200 && after - before === Number(required.accepts[0].amount), `${r2.status} +${after - before} ${JSON.stringify(body).slice(0, 80)}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
    const posts = (await j(`${MOCK}/_posts`)).filter((p) => p.kind === 'fight');
    rec('support -> backend /fight/settled', posts.length > 0 && posts.at(-1).keyOk && posts.at(-1).body.amountMicro === '2000000', JSON.stringify(posts.at(-1)));
    fs.writeFileSync(process.env.E2E_OUT, JSON.stringify(results, null, 1));
  });
});
