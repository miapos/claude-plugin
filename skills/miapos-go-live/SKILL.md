---
name: miapos-go-live
description: Pre-launch review of a miaPOS e-commerce integration before switching from the sandbox to production — credentials, callback signature, status handling, reconciliation, return URLs, mobile bank-app redirect and test cases. Use when the user says their miaPOS / MIA checkout is ready, asks what to check before going live, or wants an audit of an existing miaPOS integration.
---

# miaPOS go-live review

Review the user's integration against this list. Read their code; do not assume. For every item report **OK / MISSING / WRONG** with the file and line, then a short fix list ordered by risk. Items marked 🔴 block launch.

## 1. Credentials and environment

- 🔴 Secret key is read from env/secret store on the server, and is absent from the repo, frontend bundle and logs.
- 🔴 Production base URL, merchant ID, secret key and terminal ID come from the merchant's bank / miaPOS onboarding, not from the sandbox (`ecomm-test.miapos.md`, merchant `128`).
- Sandbox and production public keys are kept apart, with one cached key per environment.
- The access token (300 s) is cached and renewed. The code does not fetch a token per request in a hot path.

## 2. Creating payments

- 🔴 `currency` is always `MDL`; non-MDL is rejected before calling miaPOS.
- 🔴 `paymentId` is stored on the order **before** redirecting the buyer.
- `amount` is sent with two decimals, from the server-side order total. It must never come from the browser.
- `payDescription` is meaningful to the payer, e.g. "Order #123, shop.md".
- `directRedirect: true` is set for QR payments, or "Direct redirect" is enabled in the module.
- `callbackUrl`, `successUrl` and `failUrl` are sent explicitly, over HTTPS, and include the shop's own order reference.
- Deprecated `clientPhone` is not sent.

## 3. Callback handler

- 🔴 The signature is verified exactly as in skill **verify-miapos-callback**: sorted keys, `;`-joined values, `amount` with 2 decimals, RSA-SHA256. Invalid → 400.
- 🔴 The order is looked up by `paymentId`, and `amount` + `currency` are checked against it.
- 🔴 Processing is idempotent: a replayed callback does not fulfil twice, and a final status is never downgraded.
- The handler answers 2xx quickly. miaPOS sends **once** with a 60 s timeout and never retries.
- The endpoint is publicly reachable, has no auth wall or CSRF check, and accepts `application/json` POST.

## 4. Return URLs and reconciliation

- 🔴 Reaching `successUrl` alone never marks an order paid. The code calls `GET /ecomm/api/v1/payment/{paymentId}`.
- 🔴 A scheduled job polls payments still `CREATED` or `PENDING` until they reach a final status (`SUCCESS`, `FAILED`, `DECLINED`, `EXPIRED`). Without it, a lost callback leaves a paid order unpaid.
- All six statuses are mapped to shop states, and the buyer can retry after `FAILED`, `DECLINED` or `EXPIRED`.
- `paymentDate` is treated as Chișinău local time (no offset), not UTC.
- `swiftMessageId` and `swiftPayerBank` are stored for bookkeeping and reconciliation.

## 5. Test evidence (sandbox)

Ask for evidence of each, or run them with the miaPOS MCP `sandbox_*` tools:

| Case | Expected |
|---|---|
| normal payment | order paid once, `SUCCESS` |
| buyer abandons checkout | `EXPIRED` after the QR TTL (about 5 min), order not paid |
| success page opened while still unpaid | order stays unpaid |
| same callback delivered twice | fulfilled once |
| callback with altered `amount` | rejected (400) |
| callback never delivered | reconciliation job marks the order paid |
| phone checkout with `directRedirect` | bank app opens without a QR scan |

## 6. Production smoke test

After switching credentials, make **one small real payment** (for example 1 MDL) end to end. Confirm the order state, the callback signature against the **production** key, and the reconciliation entry.

## Out of scope

- Romania (RoPay / RON) is not self-serve. Send the user to https://miapos.eu/en/support?utm_source=claude-plugin&utm_campaign=ro.
- Refunds, cancellations, recurring billing and request-to-pay to a phone number: https://miapos.eu/en/support.
