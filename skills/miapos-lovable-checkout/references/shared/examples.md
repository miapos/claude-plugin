<!-- Generated from skills/integrate-miapos-checkout/references/examples.md by scripts/sync-shared.mjs. Do not edit this copy. -->

# Ready-to-adapt examples

Minimal, framework-light code for the HTTP API path. Every example reads its configuration from environment variables:

```
MIAPOS_BASE_URL=https://ecomm-test.miapos.md
MIAPOS_MERCHANT_ID=…
MIAPOS_SECRET_KEY=…
MIAPOS_TERMINAL_ID=…
```

How to verify callback signatures is in `references/shared/verify-miapos-callback.md`.

## Node.js (18+, TypeScript-friendly, no dependencies)

```ts
const BASE = process.env.MIAPOS_BASE_URL!;
let cached: { token: string; exp: number } | null = null;

async function api(path: string, init: RequestInit = {}, auth = true): Promise<any> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = `Bearer ${await token()}`;
  const res = await fetch(BASE + path, { ...init, headers, signal: AbortSignal.timeout(30_000) });
  const body = await res.text();
  if (!res.ok) throw new Error(`miaPOS ${res.status}: ${body || res.statusText}`);
  return body ? JSON.parse(body) : null;
}

async function token(): Promise<string> {
  if (cached && Date.now() < cached.exp) return cached.token;
  const t = await api("/ecomm/api/v1/token", {
    method: "POST",
    body: JSON.stringify({ merchantId: process.env.MIAPOS_MERCHANT_ID, secretKey: process.env.MIAPOS_SECRET_KEY }),
  }, false);
  cached = { token: t.accessToken, exp: Date.now() + (t.accessTokenExpiresIn - 30) * 1000 };
  return cached.token;
}

export async function createPayment(order: { id: string; amountMdl: number; description: string }, siteUrl: string) {
  const p = await api("/ecomm/api/v1/pay", {
    method: "POST",
    body: JSON.stringify({
      terminalId: process.env.MIAPOS_TERMINAL_ID,
      orderId: order.id,
      amount: Number(order.amountMdl.toFixed(2)),
      currency: "MDL",
      payDescription: order.description,
      paymentType: "qr",
      language: "ro",
      directRedirect: true,
      callbackUrl: `${siteUrl}/miapos/callback`,
      successUrl: `${siteUrl}/checkout/return?order=${encodeURIComponent(order.id)}`,
      failUrl: `${siteUrl}/checkout/return?order=${encodeURIComponent(order.id)}`,
    }),
  });
  // Persist p.paymentId on the order BEFORE redirecting.
  return p as { orderId: string; paymentId: string; checkoutPage: string };
}

export const getPayment = (paymentId: string) =>
  api(`/ecomm/api/v1/payment/${encodeURIComponent(paymentId)}`);

export const FINAL = new Set(["SUCCESS", "FAILED", "DECLINED", "EXPIRED"]);
```

The return route loads the order, calls `getPayment(order.paymentId)` and acts on `status`. A reconciliation job does the same for orders still `CREATED` or `PENDING`.

## Python (3.9+, `requests`)

```python
import os, time, requests

BASE = os.environ["MIAPOS_BASE_URL"]
_tok = {"value": None, "exp": 0.0}

def _token() -> str:
    if _tok["value"] and time.time() < _tok["exp"]:
        return _tok["value"]
    r = requests.post(f"{BASE}/ecomm/api/v1/token", timeout=30, json={
        "merchantId": os.environ["MIAPOS_MERCHANT_ID"], "secretKey": os.environ["MIAPOS_SECRET_KEY"]})
    r.raise_for_status()
    t = r.json()
    _tok.update(value=t["accessToken"], exp=time.time() + t["accessTokenExpiresIn"] - 30)
    return _tok["value"]

def _api(method: str, path: str, **kw):
    r = requests.request(method, BASE + path, timeout=30,
                         headers={"Authorization": f"Bearer {_token()}"}, **kw)
    if not r.ok:
        raise RuntimeError(f"miaPOS {r.status_code}: {r.text}")
    return r.json()

def create_payment(order_id: str, amount_mdl: float, description: str, site_url: str) -> dict:
    return _api("POST", "/ecomm/api/v1/pay", json={
        "terminalId": os.environ["MIAPOS_TERMINAL_ID"], "orderId": order_id,
        "amount": round(amount_mdl, 2), "currency": "MDL", "payDescription": description,
        "paymentType": "qr", "language": "ro", "directRedirect": True,
        "callbackUrl": f"{site_url}/miapos/callback",
        "successUrl": f"{site_url}/checkout/return?order={order_id}",
        "failUrl": f"{site_url}/checkout/return?order={order_id}",
    })  # -> {"orderId", "paymentId", "checkoutPage"}; store paymentId first

def get_payment(payment_id: str) -> dict:
    return _api("GET", f"/ecomm/api/v1/payment/{payment_id}")

FINAL = {"SUCCESS", "FAILED", "DECLINED", "EXPIRED"}
```

## One payment without a website (Node.js 18+, no dependencies)

For a seller with no shop and no server, or an AI agent taking one payment: create the payment, hand the buyer the link, poll until the status is final. No callback. The `paymentId` is saved next to the script, so a rerun keeps polling the same payment instead of charging the buyer twice.

```js
// pay-once.mjs   node pay-once.mjs <orderId> <amountMdl> "<what the buyer pays for>"
// Use a new orderId for every sale. A rerun with the same orderId keeps checking the same payment.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

for (const v of ["MIAPOS_BASE_URL", "MIAPOS_MERCHANT_ID", "MIAPOS_SECRET_KEY", "MIAPOS_TERMINAL_ID"])
  if (!process.env[v]) throw new Error(`set ${v}`);
const BASE = process.env.MIAPOS_BASE_URL;
const FINAL = new Set(["SUCCESS", "FAILED", "DECLINED", "EXPIRED"]);
const [orderId, amountArg, description] = process.argv.slice(2);
const amount = Number(Number(amountArg).toFixed(2));
if (!orderId || !(amount > 0) || !description) throw new Error("usage: <orderId> <amountMdl> <description>");
const saved = `.miapos-${encodeURIComponent(orderId)}.json`;  // this order's payment, so a rerun never creates a second one

let cached = null;
async function token() {
  if (cached && Date.now() < cached.exp) return cached.value;
  const t = await request("/ecomm/api/v1/token",
    { merchantId: process.env.MIAPOS_MERCHANT_ID, secretKey: process.env.MIAPOS_SECRET_KEY }, false);
  cached = { value: t.accessToken, exp: Date.now() + (t.accessTokenExpiresIn - 30) * 1000 };  // lasts 300 s
  return cached.value;
}

async function request(path, body, auth = true) {
  const headers = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = `Bearer ${await token()}`;
  const res = await fetch(BASE + path, { method: body ? "POST" : "GET", headers,
    body: body && JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (res.status === 401) cached = null;  // the next call gets a fresh token
  if (!res.ok) throw new Error(`miaPOS ${res.status}: ${text}`);
  return JSON.parse(text);
}

const getPayment = (id) => request(`/ecomm/api/v1/payment/${encodeURIComponent(id)}`);

// Reuse this order's saved payment unless it already ended unpaid.
let payment = existsSync(saved) ? JSON.parse(readFileSync(saved, "utf8")) : null;
if (payment && payment.amount !== amount)
  throw new Error(`order ${orderId} already has a payment of ${payment.amount} MDL: use a new orderId`);
let s = payment && (await getPayment(payment.paymentId));
if (s && s.status !== "SUCCESS" && FINAL.has(s.status)) payment = s = null;
if (!payment) {
  const p = await request("/ecomm/api/v1/pay", {
    terminalId: process.env.MIAPOS_TERMINAL_ID, orderId, amount, currency: "MDL",
    payDescription: description, paymentType: "qr", language: "ro", directRedirect: true,
    // no callbackUrl: nothing public to receive it, so the loop below polls
  });
  payment = { orderId, amount, paymentId: p.paymentId, checkoutPage: p.checkoutPage };
  writeFileSync(saved, JSON.stringify(payment));
}
if (!s || !FINAL.has(s.status)) console.log(`Send the buyer this link: ${payment.checkoutPage}`);

const deadline = Date.now() + 6 * 60_000;  // the QR lives about 5 minutes
while (!(s && FINAL.has(s.status)) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5_000));
  try { s = await getPayment(payment.paymentId); }
  catch (e) { console.error(`Status check failed, trying again: ${e.message}`); }
}

const amountOk = s?.currency === "MDL" && Math.round(s.amount * 100) === Math.round(amount * 100);  // 170, not 170.00
if (s?.status === "SUCCESS" && amountOk) console.log(`Paid: ${s.amount} MDL at ${s.paymentDate}`);
else if (s?.status === "SUCCESS") console.log(`Paid ${s.amount} ${s.currency}, expected ${amount} MDL: check by hand`);
else if (s && FINAL.has(s.status)) console.log(`Not paid: ${s.status}`);
else console.log(`Still ${s?.status ?? "unknown"}: run again later to keep checking, it will not create a new payment`);
```

In the sandbox, set the four variables to the test values in the skill's Step 2, run the script, and play the buyer from a second terminal: `curl -d "paymentId=<paymentId>" https://ecomm-test.miapos.md/checkout`. The script prints `Paid` about 10 s later.

## PHP (SDK)

```php
// Install from GitHub:
//   composer config repositories.miapos vcs https://github.com/miapos/mia-pay-ecomm-php-sdk
//   composer require miapos/mia-pos-sdk
use Finergy\MiaPosSdk\MiaPosSdk;

$sdk = MiaPosSdk::getInstance(getenv('MIAPOS_BASE_URL'), getenv('MIAPOS_MERCHANT_ID'), getenv('MIAPOS_SECRET_KEY'));

$payment = $sdk->createPayment([
    'terminalId'     => getenv('MIAPOS_TERMINAL_ID'),
    'orderId'        => $orderId,
    'amount'         => round($total, 2),
    'currency'       => 'MDL',
    'payDescription' => "Order #$orderId",
    'paymentType'    => 'qr',
    'language'       => 'ro',
    'directRedirect' => true,
    'callbackUrl'    => "$siteUrl/miapos/callback",
    'successUrl'     => "$siteUrl/checkout/return?order=$orderId",
    'failUrl'        => "$siteUrl/checkout/return?order=$orderId",
]);
// store $payment['paymentId'] on the order, then:
header('Location: ' . $payment['checkoutPage']);

$status = $sdk->getPaymentStatus($paymentId); // ['status' => 'SUCCESS', ...]
```

The SDK caches and refreshes tokens itself. The PHP namespace stays `Finergy\MiaPosSdk`.
