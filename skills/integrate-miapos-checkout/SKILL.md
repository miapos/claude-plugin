---
name: integrate-miapos-checkout
description: Integrate miaPOS checkout into an online shop or web app so customers pay by QR code / instant bank transfer (MIA instant payments, Moldova, MDL). Use when the user wants to accept payments with miaPOS or MIA, add "Pay with MIA", connect WooCommerce, OpenCart, CS-Cart, Laravel or plain PHP, Node.js, Python or any backend to the miaPOS e-commerce API, test a payment in the miaPOS sandbox, or take a single payment for a seller who has no website (a link sent in a chat, or an AI agent that needs to get paid).
---

# Integrate miaPOS checkout

miaPOS e-commerce lets a shop take payments through **MIA**, Moldova's instant payment system. The buyer scans a QR code, or on a phone jumps straight into their banking app. The money moves account-to-account in seconds. Currency is **MDL only**.

The flow is always the same, whatever the stack:

```
your backend ──POST /ecomm/api/v1/token──▶ accessToken (5 min)
your backend ──POST /ecomm/api/v1/pay────▶ { paymentId, checkoutPage }
buyer's browser ──redirect──▶ checkoutPage  (QR / bank-app jump)
miaPOS ──POST callbackUrl (signed, retried until 2xx)──▶ your backend
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
| Any PHP | SDK, installed from GitHub | `composer config repositories.miapos vcs https://github.com/miapos/mia-pay-ecomm-php-sdk`, then `composer require miapos/mia-pos-sdk` |
| Anything else (Node, Python, Go, Java, .NET, Laravel without the SDK…) | HTTP API directly | `references/api.md`, `references/examples.md` |
| No website: a seller in a chat, or an AI agent taking one payment | payment link + status polling | **One payment without a website** below |

With a ready module the work is configuration: merchant ID, secret key, terminal ID, base URL, the order-status mapping, then a sandbox test. Turn on **Direct redirect** in the module settings: on phones the checkout page then jumps straight into the bank app.

## Step 2 — credentials and environments

| | Sandbox | Production |
|---|---|---|
| Base URL | `https://ecomm-test.miapos.md` | given by the merchant's bank / miaPOS at onboarding (one per bank) |
| Merchant ID | `128` (shared public test merchant) | issued at onboarding |
| Terminal ID | `TE0001` | the merchant's e-commerce terminal |
| Secret key | the test merchant's key, published in the PHP SDK example: https://github.com/miapos/mia-pay-ecomm-php-sdk/blob/main/examples/create_payment.php | issued at onboarding |
| Money | none. Once the buyer step starts a test payment (Step 4), the sandbox completes it by itself | real |

With the miaPOS MCP server connected, its `sandbox_*` tools need no credentials at all.

Rules:
- The **secret key lives on the server only**: env var or secret store, never the browser, the repo or logs, and never pasted or echoed in a chat. That holds for the public test key too, so the habit carries over to production.
- Never ship sandbox credentials to production, and never guess a production base URL.
- The test merchant is shared: anyone with the public key can list its payments. Never put a buyer's name, phone, email or IDNP into `orderId`, `payDescription` or the `client*` fields there.

## Step 3 — implement (HTTP API path)

Read `references/api.md` for exact fields and errors and `references/examples.md` for ready-to-adapt code. The essentials:

1. **Token.** `POST /ecomm/api/v1/token` with `{merchantId, secretKey}` returns an `accessToken` valid for **300 s**. Cache it and renew about 30 s before expiry, either with a new token call or with `POST /ecomm/api/v1/token/refresh {refreshToken}`.
2. **Create the payment.** `POST /ecomm/api/v1/pay`, Bearer token, with:
   - required: `terminalId, orderId, amount, currency: "MDL", payDescription`;
   - also send: `paymentType: "qr"`, `language` (`ro`/`ru`/`en`), `callbackUrl`, `successUrl`, `failUrl`, `directRedirect: true`.
   - **Store `paymentId` on the order before you redirect.** `orderId` is *not* unique on the miaPOS side: a retry with the same `orderId` creates a new payment. Match everything by `paymentId`.
   - **Do not create a second payment for the same order** while one is still `CREATED` or `PENDING` for the same amount: reuse it. If it is older than about 4 minutes, check its status first and reuse it only if it is still `CREATED` or `PENDING`: the QR may have expired.
   - Put your own order reference into `successUrl` / `failUrl` (e.g. `?order=123`). miaPOS redirects to them **as-is** and appends nothing.
   - Do not send `clientPhone`: it is deprecated.
3. **Redirect** the buyer to `checkoutPage`.
4. **Callback.** miaPOS POSTs `{result, signature}` to `callbackUrl` when the payment reaches a final status. Any 2xx answer ends delivery. A non-2xx answer, a network error or no answer within 60 s is retried: up to 9 attempts in total, 30 s, 2 min, 10 min, 30 min, 2 h, 6 h, 12 h and 24 h apart (about 45 h). Every retry carries the same bytes and the same signature as the first attempt. After the 9th failure miaPOS stops trying.
   - Verify the signature before trusting it (skill **verify-miapos-callback**).
   - Answer 200 fast and process idempotently: the same callback can arrive more than once, and a retry can arrive hours after your status poll already settled the order.
   - Reject a callback with a bad signature (400), but never answer non-2xx for a callback you have already applied. Otherwise miaPOS keeps resending it for two days.
5. **Return URLs.** When the buyer lands on `successUrl` or `failUrl`, **always call `GET /ecomm/api/v1/payment/{paymentId}`**. Never mark an order paid just because the browser reached `successUrl`.
   - Mark it paid only when `status` is `SUCCESS`, `currency` is `MDL` and the amount matches the order. Compare amounts as numbers, in bani (`Math.round(amount * 100)`): a payment created with `170.00` returns `170`.
6. **Reconcile.** Retries do not make the callback a source of truth. Your endpoint can be down for longer than the retry window, misconfigured or behind a firewall. After the last attempt nothing more arrives, and the order stays unpaid although the buyer has paid. So run a job every 1–2 min for orders whose payment is `CREATED` or `PENDING`, and poll the status until it is final. The QR lives about 5 min by default (a per-terminal setting), after that `EXPIRED`.

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

## One payment without a website

For a seller who sells in a messenger, on social media or by phone, and for an AI agent asked to take a payment. There is no shop, no server and no callback: the agent sends a link and polls. Code: `references/examples.md` § One payment without a website.

1. **Create the payment** as in Step 3 with a new `orderId` (for example `chat-20261118-001`), the amount, and a `payDescription` the buyer will recognise.
   - Leave out `callbackUrl`. With nothing public to receive it, you poll instead.
   - `successUrl` / `failUrl`: the seller's public page if there is one (a social profile, for example). If you leave them out, the buyer sees the miaPOS result page, and after 10 s it sends them to the terminal's default address set at onboarding. On the shared test merchant that is `https://finergy.md`.
2. **Save `paymentId` at once**, in a file or the agent's notes, so that a rerun polls the same payment instead of creating a second one. Use a new `orderId` for every sale. If the create call timed out, look for the `orderId` in today's `GET /ecomm/api/v1/payments` before creating another payment: miaPOS may have created it anyway.
3. **Send the buyer `checkoutPage`.** On a phone it opens their banking app (`directRedirect: true`). On a computer it shows a QR to scan with the banking app.
4. **Poll** `GET /ecomm/api/v1/payment/{paymentId}` every 5 s until the status is final. Stop after about 6 minutes: the QR lives about 5 minutes, then `EXPIRED`. Renew the token on the way, it lasts 300 s.
5. **Tell the seller "paid" only on `SUCCESS`**, with `MDL` and the amount matching numerically. Anything else is not paid. A payment still `PENDING` at the deadline: check it again later, do not create a new one.

In the sandbox, play the buyer yourself (Step 4). In production a real person pays from their own banking app, and the agent never pays. Production needs the seller's own merchant ID, terminal and key from onboarding, kept in env vars or a secret store, never typed into the chat.

## Step 4 — test in the sandbox

If the miaPOS MCP tools are available, use them:

1. `sandbox_create_payment` creates a test payment and returns `paymentId` and `checkoutPage`.
2. `sandbox_simulate_payment` starts the payment on the checkout page the way the buyer's browser does. The sandbox then pays by itself: `PENDING` after about 5 s, `SUCCESS` after about 10 s.
3. `sandbox_payment_status` shows the current status and the callback the sandbox sent, if a callback inbox was used.
4. `verify_callback_signature` checks a callback body plus its signature.

Without the tools, do the same by hand with the sandbox credentials from Step 2: create a payment against `https://ecomm-test.miapos.md`, then open `checkoutPage` in a browser and poll the status. To start it without a browser, send the same form POST the page sends, to the `checkoutPage` address without its query string:

```bash
curl -d "paymentId=<paymentId>" https://ecomm-test.miapos.md/checkout
```

It answers 200 with an HTML "processing" page; nothing in it needs parsing. Then poll `GET /ecomm/api/v1/payment/{paymentId}`: `PENDING` after about 2–5 s, `SUCCESS` after about 10–12 s. The polling loop is in `references/examples.md` § One payment without a website.

Do not script a plain GET of `checkoutPage` to pay: a GET only loads the page (link previews and crawlers fetch it too), and the payment starts from the page's own POST. The sandbox cannot reach `localhost`, so use a public tunnel for `callbackUrl` or rely on polling.

Test at least these cases:
- one successful payment;
- one abandoned payment that reaches `EXPIRED` after the TTL;
- the success page reached with an unpaid payment, which must **not** mark the order paid;
- a replayed callback, which must be processed once and still answered 200;
- a callback with a tampered amount, which must be rejected.

## Step 5 — before going live

Run the skill **miapos-go-live**.

## Help

- Docs: https://miapos.eu/en/docs/ · API reference: https://miapos.eu/en/docs/api/
- Support: https://miapos.eu/en/support
