---
name: integrate-miapos-checkout
description: Integrate miaPOS checkout into an online shop or web app so customers pay by QR code / instant bank transfer (MIA instant payments, Moldova, MDL). Use when the user wants to accept payments with miaPOS or MIA, add "Pay with MIA", connect WooCommerce, OpenCart, CS-Cart, Laravel or plain PHP, Node.js, Python or any backend to the miaPOS e-commerce API, or test a payment in the miaPOS sandbox.
---

# Integrate miaPOS checkout

miaPOS e-commerce lets a shop take payments through **MIA**, Moldova's instant payment system. The buyer scans a QR code, or on a phone jumps straight into their banking app. The money moves account-to-account in seconds. Currency is **MDL only**.

The flow is always the same, whatever the stack:

```
your backend ──POST /ecomm/api/v1/token──▶ accessToken (5 min)
your backend ──POST /ecomm/api/v1/pay────▶ { paymentId, checkoutPage }
buyer's browser ──redirect──▶ checkoutPage  (QR / bank-app jump)
miaPOS ──POST callbackUrl (signed, ONE attempt)──▶ your backend
buyer's browser ◀──redirect── successUrl / failUrl
your backend ──GET /ecomm/api/v1/payment/{paymentId}──▶ final status   ← the source of truth
```

## Step 0 — scope check (do this first)

- **Romania (RoPay, RON):** online checkout through miaPOS in Romania is not self-serve. **Do not write integration code for it.** Tell the user to contact the miaPOS team for integration support: https://miapos.eu/en/support?utm_source=claude-plugin&utm_campaign=ro
- **Any currency other than MDL:** the sandbox accepts the request, but the payment ends in `FAILED`. Stop and explain.
- **Refunds, cancellations, recurring billing, request-to-pay to a phone number** are outside this skill. Point the user to https://miapos.eu/en/support.

## Step 1 — pick the path

| The shop runs on | Use | Where |
|---|---|---|
| WooCommerce | ready module | https://github.com/miapos/mia-pay-gateway-for-woocommerce |
| OpenCart 3 | ready module | https://github.com/miapos/mia-pay-gateway-for-opencart |
| CS-Cart | ready module | https://github.com/miapos/mia-pay-gateway-for-cscart |
| Any PHP | SDK | `composer require miapos/mia-pos-sdk` — https://github.com/miapos/mia-pay-ecomm-php-sdk |
| Anything else (Node, Python, Go, Java, .NET, Laravel without the SDK…) | HTTP API directly | `references/api.md`, `references/examples.md` |

With a ready module the work is configuration: merchant ID, secret key, terminal ID, base URL, the order-status mapping, then a sandbox test. Turn on **Direct redirect** in the module settings: on phones the checkout page then jumps straight into the bank app.

## Step 2 — credentials and environments

| | Sandbox | Production |
|---|---|---|
| Base URL | `https://ecomm-test.miapos.md` | given by the merchant's bank / miaPOS at onboarding (one per bank) |
| Merchant ID / secret / terminal | shared public test merchant — use the `sandbox_*` tools of the miaPOS MCP server, or ask the user for their own sandbox credentials | issued at onboarding |
| Money | none — the sandbox pays itself | real |

Rules:
- The **secret key lives on the server only**: env var or secret store, never the browser, the repo or logs.
- Never ship sandbox credentials to production, and never guess a production base URL.

## Step 3 — implement (HTTP API path)

Read `references/api.md` for exact fields and errors and `references/examples.md` for ready-to-adapt code. The essentials:

1. **Token.** `POST /ecomm/api/v1/token` with `{merchantId, secretKey}` returns an `accessToken` valid for **300 s**. Cache it and renew about 30 s before expiry, either with a new token call or with `POST /ecomm/api/v1/token/refresh {refreshToken}`.
2. **Create the payment.** `POST /ecomm/api/v1/pay`, Bearer token, with:
   - required: `terminalId, orderId, amount, currency: "MDL", payDescription`;
   - also send: `paymentType: "qr"`, `language` (`ro`/`ru`/`en`), `callbackUrl`, `successUrl`, `failUrl`, `directRedirect: true`.
   - **Store `paymentId` on the order.** `orderId` is *not* unique on the miaPOS side: a retry with the same `orderId` creates a new payment. Match everything by `paymentId`.
   - Put your own order reference into `successUrl` / `failUrl` (e.g. `?order=123`). miaPOS redirects to them **as-is** and appends nothing.
   - Do not send `clientPhone`: it is deprecated.
3. **Redirect** the buyer to `checkoutPage`.
4. **Callback.** miaPOS POSTs `{result, signature}` to `callbackUrl` **once, with no retries**. A non-2xx answer or a timeout (60 s) loses that notification.
   - Verify the signature before trusting it (skill **verify-miapos-callback**).
   - Answer 200 fast and process idempotently.
5. **Return URLs.** When the buyer lands on `successUrl` or `failUrl`, **always call `GET /ecomm/api/v1/payment/{paymentId}`**. Never mark an order paid just because the browser reached `successUrl`.
6. **Reconcile.** Because the callback is single-shot, run a job every 1–2 min for orders whose payment is `CREATED` or `PENDING`. Poll the status until it is final. The QR lives about 5 min by default (a per-terminal setting), after that `EXPIRED`.

### Statuses

| Status | Meaning | Final? | Shop action |
|---|---|---|---|
| `CREATED` | payment registered, buyer has not paid yet | no | wait |
| `PENDING` | buyer confirmed, bank is processing | no | wait, keep the order reserved |
| `SUCCESS` | money transferred | **yes** | mark paid, fulfil |
| `FAILED` | payment failed | yes | mark failed, allow retry |
| `DECLINED` | declined by payer or bank | yes | mark failed, allow retry |
| `EXPIRED` | QR timed out without payment | yes | mark expired, allow retry |

On `SUCCESS` the status also carries `swiftMessageId` and `swiftPayerBank`. Store them for reconciliation.

`paymentDate` is **Chișinău local time without a timezone offset** (`2026-10-05T22:13:42`). Do not parse it as UTC.

## Step 4 — test in the sandbox

If the miaPOS MCP tools are available, use them:

1. `sandbox_create_payment` creates a test payment and returns `paymentId` and `checkoutPage`.
2. `sandbox_simulate_payment` opens the checkout page. The sandbox pays by itself: `PENDING` after about 5 s, `SUCCESS` after about 10 s.
3. `sandbox_payment_status` shows the current status and the callback the sandbox sent, if a callback inbox was used.
4. `verify_callback_signature` checks a callback body plus its signature.

Without the tools, do the same by hand: create a payment against `https://ecomm-test.miapos.md`, then `curl` the `checkoutPage` URL (no browser needed) and poll the status. The sandbox cannot reach `localhost`, so use a public tunnel for `callbackUrl` or rely on polling.

Test at least these cases:
- one successful payment;
- one abandoned payment that reaches `EXPIRED` after the TTL;
- the success page reached with an unpaid payment, which must **not** mark the order paid;
- a replayed callback, which must be processed once;
- a callback with a tampered amount, which must be rejected.

## Step 5 — before going live

Run the skill **miapos-go-live**.

## Help

- Docs: https://miapos.eu/en/docs/ · API reference: https://miapos.eu/en/docs/api/
- Support: https://miapos.eu/en/support
