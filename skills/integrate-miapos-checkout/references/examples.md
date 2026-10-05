# Ready-to-adapt examples

Minimal, framework-light code for the HTTP API path. Every example reads its configuration from environment variables:

```
MIAPOS_BASE_URL=https://ecomm-test.miapos.md
MIAPOS_MERCHANT_ID=…
MIAPOS_SECRET_KEY=…
MIAPOS_TERMINAL_ID=…
```

How to verify callback signatures is in the skill **verify-miapos-callback**.

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

## PHP (SDK)

```php
// composer require miapos/mia-pos-sdk
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
