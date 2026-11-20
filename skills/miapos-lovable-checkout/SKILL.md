---
name: miapos-lovable-checkout
description: Use when a Lovable app should take payments with miaPOS or MIA, Moldova's instant payments (QR code or bank-app jump, MDL only). Covers "add payment with miaPOS", "pay with MIA", "plată prin MIA", checkout for a cart, order, booking or donation, a payment callback or webhook, an order-paid status and a payments admin page. Builds server code, a payments table, a signed-callback route and a reconciliation job, on the miaPOS sandbox first. Not for Stripe, Paddle or cards, and not for refunds, subscriptions, request-to-pay to a phone number or Romania (RoPay).
---

# miaPOS checkout in a Lovable app

The buyer pays an order by scanning a QR code, or on a phone by jumping straight into their banking app. Money moves account to account through **MIA**, Moldova's instant payment system, in seconds. Currency is **MDL only**.

This skill is the Lovable-specific part. The protocol itself (token, payment, statuses, callback signature, go-live checks) lives in the general miaPOS skills, bundled here under `references/shared/` and generated from one source. **Read the shared file named in each step instead of guessing.** If the miaPOS connector (`https://mcp.miapos.eu/mcp`) is available in this chat, its `get_api_reference` and `search_docs` tools answer from the same text, and `verify_callback_signature` checks a callback body.

```
browser ── "Pay" ──▶ server fn createMiaposPayment ──POST /pay──▶ miaPOS
                     (amount from the database, row in miapos_payments)
browser ◀── paymentId, checkoutPage, baseUrl
browser: miaPOS widget on the page (QR, bank list), or redirect to checkoutPage
miaPOS ──signed callback, retried until 2xx──▶ API route /api/public/miapos/callback
job every minute ──▶ API route /api/public/miapos/reconcile ──GET /payment/{id}──▶ miaPOS
order page ──▶ server fn getOrderPayment ──GET /payment/{id}──▶ miaPOS     ← source of truth
```

## Step 0 — scope

Apply **Step 0** of `references/shared/integrate-miapos-checkout.md` before writing any code: Romania (RoPay, RON), any currency but MDL, refunds, cancellations, recurring billing and request-to-pay to a phone number are out of scope. Say so and point to support instead of building them.

If the user asked for payments without naming a provider and is not in Moldova, Lovable's built-in payments may fit better. miaPOS is for shops whose customers pay from Moldovan bank accounts.

## Step 1 — secrets and environment

Ask for four project secrets with the **Add secret** form. Never ask the user to paste them in the chat, and never write them into code, migrations, logs or the browser bundle. The sandbox values below are public, so you may set them yourself. A production key is entered only by the merchant, in the Add secret form; never set one from a value typed in the chat.

| Secret | Sandbox value | Production value |
|---|---|---|
| `MIAPOS_BASE_URL` | `https://ecomm-test.miapos.md` | the e-commerce address of the merchant's bank, given at onboarding |
| `MIAPOS_MERCHANT_ID` | `128` (shared test merchant) | issued at onboarding |
| `MIAPOS_SECRET_KEY` | the test merchant's key, published in the miaPOS PHP SDK example: https://github.com/miapos/mia-pay-ecomm-php-sdk/blob/main/examples/create_payment.php | issued at onboarding |
| `MIAPOS_TERMINAL_ID` | `TE0001` | the merchant's e-commerce terminal |

- **Start on the sandbox.** No real money moves there: once a test payment is started on its checkout page, the sandbox completes it by itself.
- Never guess a production base URL. Each bank runs its own host, its own credentials and its own callback signing key.
- Read the secrets only in server code (server functions and API routes, or Edge Functions in older React + Vite apps). The browser gets nothing but the `paymentId`, the `checkoutPage` and the base URL that a payment response returns.

## Step 2 — database

Create the tables with the SQL in `references/lovable-code.md` § Database. The rules behind it:

- **`miapos_payments` is keyed by `payment_id`**, the `paymentId` miaPOS returns. Everything is matched by it: the callback, the status check, the admin page. `orderId` is **not** unique on the miaPOS side, and every `/pay` call creates a new payment.
- One order can have several payments: an expired QR and a new one, for example. Reuse the payment that is still payable (`CREATED` or `PENDING`) for the order's current total instead of creating a second one, so the same order is not paid twice. Check one older than 4 minutes with miaPOS first: its QR may have expired.
- Status changes go through the database function `miapos_apply_status`. It is idempotent, never changes a final status, never moves a payment back, and marks the order paid only when the amount matches both the payment and the order's current total. What a person must look at (a wrong amount, a double payment, a success after a failure) gets a `review_reason`.
- Row level security is on for `miapos_payments`, with no policies: only server code with the service role reads or writes it. Buyers see their order's status through a server function, never the table.
- **The browser never creates orders and never writes `payment_status`, `paid_at` or `total_mdl`.** The app's public database key ships in the browser bundle, so a table policy that lets buyers insert or update their orders would also let them create one for 0.01 MDL or mark one paid. The trigger `orders_guard_payment_fields` rejects that from the browser roles, whatever policies the app has. Keep it, also on an existing orders table.
- Create orders and their totals in a server function that prices the cart from the database, with the service-role client: the signed-in user's client is refused like the browser. If the app creates orders from the browser today, move that into a server function first. The amount sent to miaPOS always comes from the database.
- Limit how often one visitor can create orders, for example per IP address. Each order can lead to a payment at miaPOS.

## Step 3 — create the payment

A server function `createMiaposPayment({ orderId })`, written from `references/lovable-code.md` § Server module and § Create payment:

1. Load the order. Refuse if it is already paid or its total is not a positive MDL amount. If the app has sign-in, check that the order belongs to the caller.
2. Reuse the open payment (see Step 2) or call `POST /ecomm/api/v1/pay`. The fields follow **Step 3** of `references/shared/integrate-miapos-checkout.md`: `paymentType: "qr"`, `currency: "MDL"`, `directRedirect: true`, a `payDescription` the payer will recognise, `callbackUrl` = `<app origin>/api/public/miapos/callback`, and `successUrl` / `failUrl` = the order page. Take the origin on the server, never from a value the browser sends: from the incoming request in a server function, from an `APP_URL` secret with the published address in an Edge Function.
3. **Insert the `miapos_payments` row before returning.** No row, no redirect.
4. Return the oldest open payment of the order: `{ paymentId, checkoutPage, baseUrl }`. Two clicks at once then hand the buyer the same payment. The other one is never opened, and a payment nobody opens cannot be paid.

On an error, log it on the server and show the buyer a plain message, not the miaPOS error text.

The access token lives 300 s. Cache it in the server module and renew it 30 s early. Field details and errors: `references/shared/api.md`.

## Step 4 — show the payment to the buyer

Use the **miaPOS widget** (version 0.2.0, served by the bank's own host) on the checkout page. It shows the QR code and a "Choose your bank" list that opens the banking app on phones, and it follows the status by itself. Code: `references/lovable-code.md` § Widget.

- Load `<baseUrl>/js/v1/miapos.js` and call `window.miaPOS.mount(element, { paymentId, locale, directRedirect: true, onSuccess, onFail })`. `locale` is `ro`, `ru` or `en`.
- **If the script fails to load, or `window.miaPOS` is missing** (an old browser), send the buyer to `checkoutPage` instead. That full page does the same job.
- Destroy the widget on unmount. A second `mount` on the same element replaces the first.
- `onSuccess` is a signal to ask your server, not proof of payment: call `getOrderPayment` and show what the server says.

Redirecting to `checkoutPage` right away, without the widget, is a valid simpler choice.

## Step 5 — callback route

An API route `POST /api/public/miapos/callback` (an Edge Function in older apps). Lovable keeps routes that outside services call under `/api/public/`. The code is in `references/lovable-code.md` § Callback. The signature algorithm and its pitfalls are in `references/shared/verify-miapos-callback.md`. Follow it exactly.

- No sign-in, no CSRF check: miaPOS calls it server to server. The signature is the only proof, so verify it before anything else. Invalid → **400**.
- The public key comes from `GET /ecomm/api/v1/public-key` with a Bearer token, once per base URL, cached. On a failed check, fetch it again before rejecting, at most once every 5 minutes: anyone can post a bad signature. If the key cannot be fetched at all, answer **503** so miaPOS tries again later.
- Apply the status with `miapos_apply_status` and answer **200** fast, also for a repeat and for a payment you do not know. miaPOS retries anything else for about 45 hours with the same body.
- Log the `paymentId` and the outcome, never the whole body.
- miaPOS cannot reach the editor preview. Callbacks arrive once the app is published, at `https://<project>.lovable.app` or a custom domain. Until then, Steps 6 and 7 confirm the payment.

## Step 6 — reconciliation job

Ask Lovable for a **scheduled job every minute** that calls `POST /api/public/miapos/reconcile`, guarded by the scheduled-job credential (`LOVABLE_CRON_SECRET`, checked with `authenticateCronRequest`). Code: `references/lovable-code.md` § Reconcile.

- Take at most 8 open payments from the last 2 days, most urgent first: `PENDING` ones, then `CREATED` ones younger than 15 minutes, each not checked in the last 50 s, then older `CREATED` ones not checked in the last 10 minutes. Call `GET /ecomm/api/v1/payment/{paymentId}` for them in parallel, each with a 4 s timeout, and apply each status.
- The job's call times out after a few seconds, so keep the batch small. A later run picks up the rest.
- A payment's QR clock starts when the buyer first opens it. One that nobody opened stays `CREATED` and never expires. The job keeps checking it, every 10 minutes, until the 2-day window ends, so abandoned carts cannot delay the payments that matter.
- This job is what keeps a paid order from staying unpaid when a callback never gets through. **It is not optional.**
- A remix of the project does not copy scheduled jobs. Recreate the job in every copy.

## Step 7 — order page and return URL

The order page (`successUrl` and `failUrl` point here) calls a server function `getOrderPayment({ orderId })`. If the latest payment is still `CREATED` or `PENDING`, the function checks `GET /payment/{paymentId}`, applies the result and returns the order's state. The page polls it every 3 s for up to 2 minutes while it is pending.

**Reaching this page proves nothing.** Never mark an order paid from the URL, a query parameter, local storage or the widget's `onSuccess`.

While the app runs on the sandbox, `testMode` is true: show "Test payment, no real money" on the order page and on the admin page, and do not fulfil those orders. Anyone can pay a sandbox order, because the sandbox completes every started test payment by itself.

Map the statuses as in **Statuses** of `references/shared/integrate-miapos-checkout.md`. On `FAILED`, `DECLINED` and `EXPIRED`, offer "Try again", which calls `createMiaposPayment` again.

## Step 8 — payments admin page

A page `/admin/payments`, behind sign-in, for users with an admin role (a `user_roles` table checked on the server). A server function checks the role and passes the result to the list functions, then calls `GET /ecomm/api/v1/payments` with `terminalId` = `MIAPOS_TERMINAL_ID`, `page`, `size` (at most 100), and optionally `paymentStatus`, `dateFrom` and `dateTo` (ISO date-time). Code: `references/lovable-code.md` § Admin list.

- The list answers `{ total, page, size, payments[] }`, and each payment's status is in **`paymentStatus`**, not `status`.
- **On the sandbox the test merchant is shared**, so the list also holds other developers' test payments. There, show only the payment IDs that are in your own `miapos_payments` table.
- Show date, order, amount, status, payer bank and `swiftMessageId`. Add a "Check now" button for pending rows that runs the same check as Step 7.
- Put the payments that need review (`listPaymentsNeedingReview`) at the top, with their reason: a wrong amount, a double payment or a success after a failure. After checking one in the Merchant Portal, the admin settles the order as paid or unpaid with `resolveReview`.
- Refunds are not in the API. Point the merchant to the miaPOS Merchant Portal for them.

## Step 9 — test on the sandbox

The sandbox pays a payment by itself once the widget shows its QR, or once the checkout page starts: `PENDING` after about 5 s, `SUCCESS` after about 10–12 s. Then check:

| Case | Expected |
|---|---|
| pay an order in the preview | order page turns **paid** through the status check, within about 15 s |
| same, in the published app | the callback arrives and the order is paid by it. The admin page shows the payment |
| open the order page while the payment is still `CREATED` | the order is not paid |
| click "Pay" twice at once | both clicks show the same payment |
| replay the same callback body | answered 200, order paid once |
| `GET` on the callback route | not handled by it: the route takes `POST` only |
| callback with a changed `amount` | 400, nothing changes |
| browser client sets `payment_status = 'paid'` on an order, or inserts an order | rejected by the database |
| leave checkout without opening the payment, come back later | not paid; "Pay" reuses the same payment |
| phone, published app | "Choose your bank" opens the banking app |

`EXPIRED` and "Try again" cannot be produced on the sandbox, because it pays every payment that is opened. Check them on production in Step 10.

Also run the general list in **Test evidence** of `references/shared/miapos-go-live.md`.

## Step 10 — going live (a separate step)

Do this only when the user asks for it, and never together with other changes:

1. Replace the four secrets with the production values from the merchant's bank. The code does not change. Orders paid on the sandbox stay marked paid: delete them, or keep them out of fulfilment (their payments have `environment = 'sandbox'`).
2. Run the review in `references/shared/miapos-go-live.md` against this app's code and report each item.
3. Make one real payment of 1 MDL end to end, then check the order, the callback signature against the production key, and the admin page.
4. Open a second 1 MDL payment and leave it unpaid. After about 5 minutes the order page shows it expired and "Try again" creates a new payment.

`miapos_payments.environment` records which environment each payment came from, so sandbox rows never count as real money.

## Avoid

- Marking an order paid without a status that came from your server: a verified callback, or `GET /payment/{paymentId}`.
- Calling miaPOS from the browser with the secret key, or exposing the token.
- Answering 4xx or 5xx to a callback you have already applied.
- Creating a second payment while the first one is still payable.
- Parsing `paymentDate` as UTC. It is Chișinău local time without an offset.
- Copying sandbox secrets into production, or production secrets into a remix.

## Help

Docs: https://miapos.eu/en/docs/ · Support, including Romania and production onboarding: https://miapos.eu/en/support
