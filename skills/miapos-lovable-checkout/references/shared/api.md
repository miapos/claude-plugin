<!-- Generated from skills/integrate-miapos-checkout/references/api.md by scripts/sync-shared.mjs. Do not edit this copy. -->

# miaPOS e-commerce API — reference

Everything here was observed against the live sandbox `https://ecomm-test.miapos.md` on 05.10.2026. Callback delivery was rechecked on 17.11.2026; the payment list, the buyer step and the default return address on 18.11.2026. Production behaves the same; only the base URL and credentials differ, one set per bank.

All requests and responses are JSON (`Content-Type: application/json`). Authenticated calls send `Authorization: Bearer <accessToken>`.

## POST /ecomm/api/v1/token

Request: `{"merchantId": "128", "secretKey": "…"}`

Response 200:
```json
{"accessToken":"…","accessTokenExpiresIn":300,"refreshToken":"…","refreshTokenExpiresIn":432000,"tokenType":"Bearer"}
```

## POST /ecomm/api/v1/token/refresh

Request: `{"refreshToken": "…"}` → same shape as `/token`.

## POST /ecomm/api/v1/pay

| Field | Type | Required | Notes |
|---|---|---|---|
| `terminalId` | string | yes | e-commerce terminal, e.g. `TE0001` in the sandbox |
| `orderId` | string | yes | your reference. **Not unique on miaPOS side**: every call creates a new payment |
| `amount` | number | yes | `> 0`, two decimals, e.g. `150.75` |
| `currency` | string | yes | `MDL`. Other values are accepted, but the payment then goes `FAILED` |
| `payDescription` | string | yes | shown to the payer in the banking app |
| `paymentType` | string | no | `qr` (default). `rtp` needs a separate RTP terminal and is out of scope here |
| `language` | string | no | checkout page language: `ro`, `ru`, `en` |
| `callbackUrl` | string | no* | where the signed result is POSTed when the payment is final. Retried until a 2xx answer, up to 9 attempts |
| `successUrl` / `failUrl` | string | no* | browser redirect targets, used **as-is** with nothing appended |
| `directRedirect` | boolean | no | QR only. `true`: on phones the checkout page jumps straight into the banking app. Recommended |
| `fastRedirect` | boolean | no | skip the pause on the result screen |
| `clientName`, `clientEmail` | string | no | optional payer details |
| `clientPhone` | string | — | **deprecated**, do not send |

\* If omitted, the terminal's default URLs configured at onboarding are used: the callback goes to the terminal's default address, not to you, and the result page's "Back to shop" goes to the terminal's address (on the shared test merchant, `https://finergy.md`). Send them explicitly whenever you have a server. Without one, leave `callbackUrl` out and poll.

Response 200:
```json
{"orderId":"order-123","paymentId":"c81b7a16-9c64-494c-88b1-26ec2c6328fe","checkoutPage":"https://ecomm-test.miapos.md/checkout?paymentId=c81b7a16-…"}
```

## GET /ecomm/api/v1/payment/{paymentId}

Response 200 is a flat object with **no signature**:
```json
{"terminalId":"TE0001","orderId":"order-123","paymentId":"c81b7a16-…","status":"SUCCESS",
 "amount":12.5,"currency":"MDL","paymentDate":"2026-10-05T22:13:42",
 "swiftMessageId":"dc00bf4d-…","swiftPayerBank":"CMTBMD2X","paymentType":"qr",
 "checkoutPage":"https://ecomm-test.miapos.md/checkout?paymentId=c81b7a16-…"}
```

- `swiftMessageId` and `swiftPayerBank` appear once the payment succeeds.
- `paymentDate` is Chișinău local time **without offset**.
- `amount` is a JSON number: a payment created with `170.00` returns `170`. Compare amounts numerically, never as strings.

## GET /ecomm/api/v1/payments

The merchant's payments, newest first. Bearer required.

| Query parameter | Notes |
|---|---|
| `terminalId` | optional; without it, all terminals of the merchant |
| `page` | 0-based |
| `size` | 1–100. A larger value returns HTTP 500 |
| `paymentStatus` | optional: `CREATED`, `PENDING`, `SUCCESS`, `FAILED`, `DECLINED`, `EXPIRED` |
| `dateFrom`, `dateTo` | optional, local date-time `2026-11-18T00:00:00`. A bare date returns 400 |

There is no `orderId` filter: an unknown parameter is ignored and the whole list comes back. To find an order's payments, filter by date and match `orderId` yourself, or better, keep the `paymentId`.

Response 200:
```json
{"total":1231,"page":0,"size":2,"payments":[
  {"paymentId":"4f6f1d34-…","orderId":"order-123","terminalId":"TE0001","amount":170,"currency":"MDL",
   "payDescription":"…","paymentType":"qr","createdAt":"2026-11-18T20:13:10","paymentDate":"2026-11-18T20:13:22",
   "swiftMessageId":"…","swiftPayerBank":"…","paymentStatus":"SUCCESS"}]}
```

Here the status field is `paymentStatus`, not `status` as in `GET /payment/{paymentId}`.

## The buyer step (sandbox)

The checkout page starts the payment with a form POST to `/checkout` carrying `paymentId`. Sending the same POST from a script plays the buyer in the sandbox:

```bash
curl -d "paymentId=<paymentId>" https://ecomm-test.miapos.md/checkout
```

- Answer: HTTP 200, an HTML "processing" page that resubmits itself every 10 s. Nothing in it needs parsing.
- Status: `PENDING` after about 2–5 s, `SUCCESS` after about 10–12 s. Poll `GET /payment/{paymentId}` for it.
- Once the payment is final, the page shows the result and after 10 s sends the browser to `successUrl` / `failUrl`, or to the terminal's default address if they were omitted.
- A plain GET of `checkoutPage` only loads the page and never starts the payment.

## GET /ecomm/api/v1/public-key

Bearer required (401 without it). Response: `{"publicKey":"MIIBIjANBgkq…"}`, a base64 DER SubjectPublicKeyInfo.

- **Each environment has its own key:** the sandbox and every production bank.
- Older docs show `/api/v1/public-key`. That path is wrong and returns 500.

## Callback (POST to your callbackUrl)

```json
{
  "result": {"terminalId":"…","orderId":"…","paymentId":"…","status":"SUCCESS","amount":145.25,
             "currency":"MDL","paymentType":"qr","paymentDate":"2026-10-05T22:13:42",
             "swiftMessageId":"…","swiftPayerBank":"…"},
  "signature": "base64…"
}
```

- Sent when the payment reaches a final status (`SUCCESS`, `FAILED`, `DECLINED`, `EXPIRED`).
- **Delivery:** any 2xx answer ends it. A non-2xx answer, a network error or no answer within 60 s is retried, up to 9 attempts in total. The gaps are 30 s, 2 min, 10 min, 30 min, 2 h, 6 h, 12 h and 24 h, about 45 h end to end. After the 9th failure miaPOS stops, and the payment is left for manual review on its side.
- **Every retry carries the same bytes and the same signature** as the first attempt. Treat a repeat as a duplicate, not as a new event.
- Retries do not replace polling: `GET /payment/{paymentId}` stays the source of truth.
- Fields that are null are omitted.
- How to verify the signature: `references/shared/verify-miapos-callback.md`.

## Errors

Always HTTP 400 with `{"errorCode":"1","errorMessage":"…"}`. `errorCode` carries no meaning: branch on the HTTP status and show `errorMessage`.

| Situation | errorMessage (sample) |
|---|---|
| missing field | `Field 'terminalId' with value 'null' failed validation, reason - terminalId is required.` |
| unknown terminal | `Pos terminal with id: [X] not found` |
| amount ≤ 0 | `Field 'amount' with value '0' failed validation, reason - must be greater than 0.` |
| wrong terminal type | `The terminal type must be [rtp] when the payment type is [RTP]. Current terminal type: [ecomm].` |
| unknown paymentId | `Ecomm payment info not found with payment id [...]` (400, not 404) |
| missing or expired token | HTTP 401, empty body. Get a new token and retry once |

Typical latency is 200–500 ms. Use a 30–60 s client timeout.
