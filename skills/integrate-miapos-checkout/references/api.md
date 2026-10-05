# miaPOS e-commerce API — reference

Everything here was observed against the live sandbox `https://ecomm-test.miapos.md` on 05.10.2026. Production behaves the same; only the base URL and credentials differ, one set per bank.

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
| `callbackUrl` | string | no* | where the signed result is POSTed **once** |
| `successUrl` / `failUrl` | string | no* | browser redirect targets, used **as-is** with nothing appended |
| `directRedirect` | boolean | no | QR only. `true`: on phones the checkout page jumps straight into the banking app. Recommended |
| `fastRedirect` | boolean | no | skip the pause on the result screen |
| `clientName`, `clientEmail` | string | no | optional payer details |
| `clientPhone` | string | — | **deprecated**, do not send |

\* If omitted, the terminal's default URLs configured at onboarding are used. Send them explicitly.

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

- Sent **once**, with a 60 s timeout. A non-2xx answer is logged on the miaPOS side and **not retried**.
- Fields that are null are omitted.
- How to verify the signature: skill **verify-miapos-callback**.

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
