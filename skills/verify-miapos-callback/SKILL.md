---
name: verify-miapos-callback
description: Verify the RSA signature of a miaPOS e-commerce payment callback (the signed {result, signature} JSON POSTed to callbackUrl) and process it safely. Use when writing or debugging a miaPOS / MIA callback or webhook handler, when a miaPOS signature check fails, or when the user asks how to trust miaPOS payment notifications.
---

# Verify a miaPOS callback

miaPOS POSTs the payment result to your `callbackUrl`:

```json
{ "result": { "terminalId": "…", "orderId": "…", "paymentId": "…", "status": "SUCCESS",
              "amount": 145.25, "currency": "MDL", "paymentType": "qr",
              "paymentDate": "2026-10-05T22:13:42", "swiftMessageId": "…", "swiftPayerBank": "…" },
  "signature": "base64…" }
```

The callback is sent **once** (60 s timeout, **no retries**), so the handler must be correct and fast. Your reconciliation job (skill **integrate-miapos-checkout**) covers callbacks that never arrive.

## The algorithm (exact)

1. Take the `result` object as received. Fields that are null are omitted by miaPOS, so do not add any.
2. Sort its keys by plain code-point order (A→Z, case-sensitive).
3. Turn each value into a string. **`amount` is always formatted with exactly two decimals** (`1775` → `1775.00`, `12.5` → `12.50`). Everything else is used as-is.
4. Join the values with `;`. Values only, no keys.
5. Verify `base64decode(signature)` over the UTF-8 bytes of that string with **RSA PKCS#1 v1.5 + SHA-256**, using the miaPOS public key.

The public key comes from `GET /ecomm/api/v1/public-key`, which **needs a Bearer token**. It returns `{"publicKey": "<base64 DER>"}`; wrap it as PEM. Each environment has its own key: the sandbox and every production bank. Cache the key per environment. If verification fails, re-fetch the key once (it may have rotated), then reject.

### Common mistakes

| Mistake | Effect |
|---|---|
| `amount` parsed as a float and printed as `1775` or `12.5` | signature never matches |
| keys in the original JSON order instead of sorted | signature never matches |
| hashing the raw request body | wrong: the signature covers the joined values, not the body |
| sandbox key used against production, or the reverse | signature never matches |
| using `/api/v1/public-key` from older docs | HTTP 500; the right path is `/ecomm/api/v1/public-key` |
| marking the order paid on the callback without checking `amount` and `currency` against the order | the payment could be accepted for the wrong amount |

## Test vector (real, verifiable against the current sandbox key)

```json
{"result":{"terminalId":"TRMW0001","orderId":"108","paymentId":"2a663962-c954-4984-90e5-1d24c3305f7b",
 "status":"EXPIRED","amount":1775.00,"currency":"MDL","paymentType":"qr","paymentDate":"2024-12-17T11:54:23"},
 "signature":"gtWkQdF2X2oCwO/+a+DJxpDc5DhjC1PMVWrnCXsCX54qOo24siRTy4PAjHoYet1r0KERVEL65p7UZuHcaK+TOiJptlalMUVZWbGLPf05WpyKPOPSPI1P4ZoADzJpceYsKjjZImB/+ft6OAF+ahxazhHkiT1Ze05vwD2L1D6zRohcxZl9XRJMChZcVD9bdNy23ozwuq6FwlnneJJeCPNvqveg7f5e0CD1NXWdLJ3WryP0ypcGtQGZAY+PrhkdVG5SWhYr0FFniAZIrp9yOFn3vrsUP4rpZmeqIahSV6x12pyyRsm+bs/tjw/kPR34ygG7ksXsrpwhQbltAHWeWwnOmg=="}
```

Expected string to verify:

```
1775.00;MDL;108;2024-12-17T11:54:23;2a663962-c954-4984-90e5-1d24c3305f7b;qr;EXPIRED;TRMW0001
```

With the sandbox public key (`https://ecomm-test.miapos.md`) the result must be **valid**. Change any character and it must become **invalid**. If the miaPOS MCP tools are available, `verify_callback_signature` runs this check for you.

## Code

### Node.js (built-in `crypto`)

```ts
import { verify } from "node:crypto";

export function signString(result: Record<string, unknown>): string {
  return Object.keys(result).sort()
    .filter((k) => result[k] !== null && result[k] !== undefined)
    .map((k) => (k === "amount" ? Number(result[k]).toFixed(2) : String(result[k])))
    .join(";");
}

export function isValidSignature(result: Record<string, unknown>, signatureB64: string, publicKeyB64: string): boolean {
  const pem = `-----BEGIN PUBLIC KEY-----\n${publicKeyB64.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----\n`;
  return verify("RSA-SHA256", Buffer.from(signString(result), "utf8"), pem, Buffer.from(signatureB64, "base64"));
}
```

### Python (`cryptography`)

```python
import base64, json
from decimal import Decimal
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.exceptions import InvalidSignature

def sign_string(result: dict) -> str:
    return ";".join(f"{Decimal(str(result[k])):.2f}" if k == "amount" else str(result[k])
                    for k in sorted(result) if result[k] is not None)

def is_valid_signature(result: dict, signature_b64: str, public_key_b64: str) -> bool:
    key = serialization.load_der_public_key(base64.b64decode(public_key_b64))
    try:
        key.verify(base64.b64decode(signature_b64), sign_string(result).encode(), padding.PKCS1v15(), hashes.SHA256())
        return True
    except InvalidSignature:
        return False

# parse callbacks with json.loads(body, parse_float=Decimal) to keep amounts exact
```

### PHP (SDK)

```php
$data = json_decode(file_get_contents('php://input'), true);
$ok = $sdk->verifySignature($sdk->formSignStringByResult($data['result']), $data['signature']);
```

The SDK fetches the public key itself on every call. In high-traffic handlers, cache it.

## Handler checklist

1. Parse the JSON. Reject it if `result` or `signature` is missing (400).
2. Verify the signature. If it is invalid, return 400 and log it **without** the full body.
3. Load the order by `result.paymentId`, not by `orderId`. Check that `amount` and `currency` match the order.
4. Apply the status **idempotently**: the same `paymentId` + `status` twice must not double-fulfil. Never downgrade a final status.
5. Answer **200 quickly**. Do slow work (emails, fulfilment) afterwards or in a queue.
6. Optional defence in depth: confirm with `GET /ecomm/api/v1/payment/{paymentId}` before fulfilment.
