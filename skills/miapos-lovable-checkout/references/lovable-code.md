# Reference code for miaPOS in a Lovable app

Adapt these to the project's template: TanStack Start server functions and API routes in new apps, Edge Functions in older React + Vite apps. The logic does not change. Every block names the file it belongs in. Everything except the widget runs on the server only.

`admin` below is the server-side database client with the service role, which the built-in backend provides. Never use the browser client for these tables.

## Database

```sql
-- file: migration (one SQL migration)
-- If the app already has an orders table, add total_mdl, payment_status and paid_at to it instead,
-- keep its policies, and keep the trigger below.
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  description text not null,
  total_mdl numeric(12,2) not null check (total_mdl > 0),
  payment_status text not null default 'unpaid'
    check (payment_status in ('unpaid', 'pending', 'paid', 'review')),
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.orders enable row level security;   -- add the read policies the app needs (owners read their orders)

-- The browser's key reaches the database too. Whatever policies the app has on orders, only server code
-- creates orders, sets their total and sets the payment fields. Without this, anyone with the app's
-- public key can create an order for 0.01 MDL or mark one paid.
create or replace function public.orders_guard_payment_fields() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      raise exception 'orders: created by the server, which prices the cart from the database';
    elsif new.payment_status is distinct from old.payment_status
       or new.paid_at is distinct from old.paid_at
       or new.total_mdl is distinct from old.total_mdl then
      raise exception 'orders: payment fields are set by the server';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists orders_guard_payment_fields on public.orders;
create trigger orders_guard_payment_fields before insert or update on public.orders
  for each row execute function public.orders_guard_payment_fields();

create table if not exists public.miapos_payments (
  payment_id uuid primary key,                  -- miaPOS paymentId: the only join key
  order_id uuid not null references public.orders(id) on delete restrict,
  environment text not null check (environment in ('sandbox', 'production')),
  amount numeric(12,2) not null check (amount > 0),
  currency text not null default 'MDL' check (currency = 'MDL'),
  status text not null default 'CREATED'
    check (status in ('CREATED', 'PENDING', 'SUCCESS', 'FAILED', 'DECLINED', 'EXPIRED')),
  checkout_page text not null,
  swift_message_id text,
  swift_payer_bank text,
  payment_date text,                            -- Chișinău local time, no offset, kept as sent
  review_reason text                            -- set when a person must look: see below
    check (review_reason in ('amount_mismatch', 'paid_twice', 'late_success')),
  callback_at timestamptz,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists miapos_payments_order_idx on public.miapos_payments (order_id, created_at);
create index if not exists miapos_payments_open_idx on public.miapos_payments (checked_at nulls first)
  where status in ('CREATED', 'PENDING');
create index if not exists miapos_payments_review_idx on public.miapos_payments (updated_at desc)
  where review_reason is not null;
-- One payable payment per order and amount: two "Pay" clicks at once cannot both record one.
create unique index if not exists miapos_payments_one_open_idx on public.miapos_payments (order_id, environment, amount)
  where status in ('CREATED', 'PENDING');

alter table public.miapos_payments enable row level security;   -- no policies: server code only

-- Applies a status from a verified callback or from GET /payment/{id}. Idempotent: a final status
-- is never changed, a stale read never moves a payment back, and the order is paid once, only when
-- the amount matches both the payment and the order's current total.
create or replace function public.miapos_apply_status(
  p_payment_id uuid, p_status text, p_amount numeric, p_currency text,
  p_swift_message_id text default null, p_swift_payer_bank text default null,
  p_payment_date text default null, p_source text default 'poll'
) returns text
language plpgsql security definer set search_path = public as $$
declare
  pay public.miapos_payments%rowtype;
  order_total numeric;
begin
  select * into pay from public.miapos_payments where payment_id = p_payment_id for update;
  if not found then
    return 'unknown';
  end if;

  update public.miapos_payments
     set checked_at = now(),
         callback_at = case when p_source = 'callback' then coalesce(callback_at, now()) else callback_at end
   where payment_id = p_payment_id;

  if p_status is null or p_status not in ('CREATED', 'PENDING', 'SUCCESS', 'FAILED', 'DECLINED', 'EXPIRED') then
    return 'unchanged';
  end if;

  if pay.status in ('SUCCESS', 'FAILED', 'DECLINED', 'EXPIRED') then
    if pay.status = p_status then
      return 'duplicate';
    end if;
    if p_status = 'SUCCESS' then
      -- money reported after a failure was stored: never drop it silently
      update public.miapos_payments set review_reason = 'late_success', updated_at = now() where payment_id = p_payment_id;
      update public.orders set payment_status = 'review' where id = pay.order_id and payment_status <> 'paid';
    end if;
    return 'conflict';
  end if;

  if p_status = pay.status or (p_status = 'CREATED' and pay.status = 'PENDING') then
    return 'unchanged';
  end if;

  update public.miapos_payments
     set status = p_status,
         swift_message_id = coalesce(p_swift_message_id, swift_message_id),
         swift_payer_bank = coalesce(p_swift_payer_bank, swift_payer_bank),
         payment_date = coalesce(p_payment_date, payment_date),
         updated_at = now()
   where payment_id = p_payment_id;

  if p_status = 'SUCCESS' then
    select total_mdl into order_total from public.orders where id = pay.order_id for update;
    if p_amount is distinct from pay.amount or p_amount is distinct from order_total
       or p_currency is distinct from pay.currency then
      update public.miapos_payments set review_reason = 'amount_mismatch' where payment_id = p_payment_id;
      update public.orders set payment_status = 'review' where id = pay.order_id and payment_status <> 'paid';
      return 'amount_mismatch';
    end if;
    update public.orders set payment_status = 'paid', paid_at = now()
     where id = pay.order_id and payment_status <> 'paid';
    if found then
      return 'paid';
    end if;
    update public.miapos_payments set review_reason = 'paid_twice' where payment_id = p_payment_id;
    return 'paid_twice';
  elsif p_status = 'PENDING' then
    update public.orders set payment_status = 'pending' where id = pay.order_id and payment_status = 'unpaid';
  elsif p_status in ('FAILED', 'DECLINED', 'EXPIRED') then
    -- back to unpaid unless another payment of the order is still open
    update public.orders o set payment_status = 'unpaid'
     where o.id = pay.order_id and o.payment_status = 'pending'
       and not exists (select 1 from public.miapos_payments m
                        where m.order_id = pay.order_id and m.payment_id <> p_payment_id
                          and m.status in ('CREATED', 'PENDING'));
  end if;
  return 'updated';
end $$;

revoke all on function public.miapos_apply_status(uuid, text, numeric, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.miapos_apply_status(uuid, text, numeric, text, text, text, text, text)
  to service_role;
```

`review_reason` marks the payments a person must look at, on the admin page:

- `amount_mismatch`: the buyer paid an amount that is not the payment's or the order's current total. The order goes to `review`.
- `paid_twice`: a second payment of an already paid order succeeded. The buyer has paid twice, and the refund goes through the Merchant Portal.
- `late_success`: miaPOS reported success after a failure or expiry was stored. The order goes to `review`.

The trigger checks the database role of the caller. Server code that creates orders or recomputes a total must use the service-role client (`admin`): a server function that uses the signed-in user's client runs as `authenticated` and is refused like the browser. A `security definer` function of the app that updates `orders` runs as its owner and is not checked, so keep payment fields out of such functions.

## Server module

```ts
// file: src/lib/miapos.server.ts  (server only; never import it from browser code)
export type MiaposStatus = "CREATED" | "PENDING" | "SUCCESS" | "FAILED" | "DECLINED" | "EXPIRED";
export const FINAL: ReadonlySet<string> = new Set(["SUCCESS", "FAILED", "DECLINED", "EXPIRED"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MiaposError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function secret(name: string): string {
  const deno = (globalThis as any).Deno;
  const value = deno ? deno.env.get(name) : typeof process !== "undefined" ? process.env[name] : undefined;
  if (!value) throw new Error(`Missing secret ${name}`);
  return value;
}

export const miaposBaseUrl = () => secret("MIAPOS_BASE_URL").replace(/\/+$/, "");
export const miaposEnvironment = () =>
  new URL(miaposBaseUrl()).hostname === "ecomm-test.miapos.md" ? "sandbox" : "production";
export const isPaymentId = (id: unknown): id is string => typeof id === "string" && UUID.test(id);

let token: { baseUrl: string; value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  const baseUrl = miaposBaseUrl();
  if (token && token.baseUrl === baseUrl && Date.now() < token.expiresAt) return token.value;
  const t = await request("/ecomm/api/v1/token", {
    method: "POST",
    body: JSON.stringify({ merchantId: secret("MIAPOS_MERCHANT_ID"), secretKey: secret("MIAPOS_SECRET_KEY") }),
  }, { auth: false });
  token = { baseUrl, value: t.accessToken, expiresAt: Date.now() + (t.accessTokenExpiresIn - 30) * 1000 };
  return token.value;
}

async function request(path: string, init: RequestInit, opts: { auth?: boolean; timeoutMs?: number } = {}): Promise<any> {
  const auth = opts.auth ?? true;
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    if (auth) headers.Authorization = `Bearer ${await accessToken()}`;
    const res = await fetch(miaposBaseUrl() + path, { ...init, headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
    if (res.status === 401 && auth && attempt === 0) { token = null; continue; }   // expired token: renew once
    const text = await res.text();
    if (!res.ok) {
      let message = res.statusText;
      try { message = JSON.parse(text).errorMessage ?? message; } catch { /* empty or not JSON */ }
      throw new MiaposError(res.status, `miaPOS ${res.status}: ${message}`);
    }
    return text ? JSON.parse(text) : null;
  }
  throw new MiaposError(401, "miaPOS 401: token rejected twice");
}

export interface CreatePaymentInput {
  orderId: string; amount: number; description: string;
  language: "ro" | "ru" | "en"; callbackUrl: string; returnUrl: string;
}

export async function createPayment(p: CreatePaymentInput): Promise<{ paymentId: string; checkoutPage: string }> {
  const amount = Math.round(p.amount * 100) / 100;
  if (!(amount > 0)) throw new MiaposError(400, "amount must be greater than 0");
  const res = await request("/ecomm/api/v1/pay", {
    method: "POST",
    body: JSON.stringify({
      terminalId: secret("MIAPOS_TERMINAL_ID"),
      orderId: p.orderId, amount, currency: "MDL", payDescription: p.description.slice(0, 120),
      paymentType: "qr", language: p.language, directRedirect: true,
      callbackUrl: p.callbackUrl, successUrl: p.returnUrl, failUrl: p.returnUrl,
    }),
  });
  if (!isPaymentId(res?.paymentId) || typeof res.checkoutPage !== "string"
      || new URL(res.checkoutPage).origin !== new URL(miaposBaseUrl()).origin) {
    throw new MiaposError(502, "miaPOS /pay: unexpected answer");
  }
  return { paymentId: res.paymentId, checkoutPage: res.checkoutPage };
}

export interface MiaposPayment {
  paymentId: string; orderId: string; status: MiaposStatus; amount: number; currency: string;
  paymentDate?: string; swiftMessageId?: string; swiftPayerBank?: string;
}

export const getPayment = (paymentId: string, timeoutMs = 10_000): Promise<MiaposPayment> =>
  request(`/ecomm/api/v1/payment/${encodeURIComponent(paymentId)}`, { method: "GET" }, { timeoutMs });

export interface PaymentList {
  total: number; page: number; size: number;
  payments: Array<{ paymentId: string; orderId: string; amount: number; currency: string; paymentStatus: MiaposStatus;
    createdAt: string; paymentDate?: string; swiftMessageId?: string; swiftPayerBank?: string; payDescription?: string }>;
}

export function listPayments(q: { page?: number; size?: number; paymentStatus?: MiaposStatus; dateFrom?: string; dateTo?: string }): Promise<PaymentList> {
  const params = new URLSearchParams({ terminalId: secret("MIAPOS_TERMINAL_ID"), page: String(q.page ?? 0), size: String(Math.min(q.size ?? 50, 100)) });
  if (q.paymentStatus) params.set("paymentStatus", q.paymentStatus);
  if (q.dateFrom) params.set("dateFrom", q.dateFrom);   // ISO date-time, e.g. 2026-11-01T00:00:00
  if (q.dateTo) params.set("dateTo", q.dateTo);
  return request(`/ecomm/api/v1/payments?${params}`, { method: "GET" });
}

// ---- callback signature: values of `result` sorted by key, joined with ";", amount with 2 decimals,
// ---- RSA PKCS#1 v1.5 + SHA-256 (references/shared/verify-miapos-callback.md)
export function signString(result: Record<string, unknown>): string {
  return Object.keys(result)
    .filter((k) => result[k] !== null && result[k] !== undefined)
    .sort()
    .map((k) => (k === "amount" ? Number(result[k]).toFixed(2) : String(result[k])))
    .join(";");
}

const KEY_REFRESH_MS = 5 * 60_000;
const keys = new Map<string, Promise<CryptoKey>>();   // one public key per base URL
const refreshedAt = new Map<string, number>();

function publicKey(refresh = false): Promise<CryptoKey> {
  const baseUrl = miaposBaseUrl();
  if (refresh) keys.delete(baseUrl);
  let key = keys.get(baseUrl);
  if (!key) {
    key = request("/ecomm/api/v1/public-key", { method: "GET" }).then((r) => {
      const der = Uint8Array.from(atob(r.publicKey), (c) => c.charCodeAt(0));
      return crypto.subtle.importKey("spki", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    });
    key.catch(() => keys.delete(baseUrl));
    keys.set(baseUrl, key);
  }
  return key;
}

function fromBase64(b64: string) {
  try { return Uint8Array.from(atob(b64.replace(/\s+/g, "")), (c) => c.charCodeAt(0)); } catch { return null; }
}

/** Throws when the key cannot be fetched (miaPOS unreachable): answer 5xx then, so miaPOS retries. */
export async function isValidCallbackSignature(result: Record<string, unknown>, signatureB64: string): Promise<boolean> {
  const signature = fromBase64(signatureB64);
  if (!signature) return false;
  const data = new TextEncoder().encode(signString(result));
  if (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", await publicKey(), signature, data)) return true;
  // The key may have rotated: fetch it again, at most once every 5 minutes, because anyone can post a bad signature.
  const baseUrl = miaposBaseUrl();
  if (Date.now() - (refreshedAt.get(baseUrl) ?? 0) < KEY_REFRESH_MS) return false;
  refreshedAt.set(baseUrl, Date.now());
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", await publicKey(true), signature, data);
}
```

## Applying a status

```ts
// file: src/lib/miapos-orders.server.ts  (server only)
import { getPayment, miaposEnvironment, type MiaposPayment } from "./miapos.server";

export async function applyStatus(admin: any, p: MiaposPayment, source: "callback" | "poll"): Promise<string> {
  const { data, error } = await admin.rpc("miapos_apply_status", {
    p_payment_id: p.paymentId, p_status: p.status, p_amount: p.amount, p_currency: p.currency,
    p_swift_message_id: p.swiftMessageId ?? null, p_swift_payer_bank: p.swiftPayerBank ?? null,
    p_payment_date: p.paymentDate ?? null, p_source: source,
  });
  if (error) throw new Error(`miapos_apply_status failed for ${p.paymentId}: ${error.message}`);
  if (data === "amount_mismatch" || data === "paid_twice" || data === "conflict") {
    console.warn("miaPOS payment needs review", p.paymentId, data);   // also on the admin page
  }
  return data as string;
}

/** Reads the status from miaPOS and applies it: the source of truth. */
export async function syncPayment(admin: any, paymentId: string, timeoutMs = 10_000): Promise<string> {
  return applyStatus(admin, await getPayment(paymentId, timeoutMs), "poll");
}

type PaymentRow = { payment_id: string; status: string; amount: number; checkout_page: string; created_at: string; checked_at: string | null };
const COLUMNS = "payment_id, status, amount, checkout_page, created_at, checked_at";

/** The most recent payment of the order on this environment: what the order page shows. */
export async function latestPayment(admin: any, orderId: string): Promise<PaymentRow | null> {
  const { data, error } = await admin.from("miapos_payments").select(COLUMNS)
    .eq("order_id", orderId).eq("environment", miaposEnvironment())
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** The oldest payment of the order that is still payable for this amount: the one the buyer gets. */
export async function openPayment(admin: any, orderId: string, amount: number): Promise<PaymentRow | null> {
  const { data, error } = await admin.from("miapos_payments").select(COLUMNS)
    .eq("order_id", orderId).eq("environment", miaposEnvironment()).eq("amount", amount)
    .in("status", ["CREATED", "PENDING"])
    .order("created_at", { ascending: true }).order("payment_id", { ascending: true }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}
```

## Create payment

```ts
// file: server function createMiaposPayment({ orderId, language })
import { createPayment, miaposBaseUrl, miaposEnvironment } from "./miapos.server";
import { openPayment, syncPayment } from "./miapos-orders.server";

const REUSE_MS = 4 * 60_000;   // a QR lives about 5 min from its first open: check an older payment before reuse

/**
 * `origin` is the app's own address, never a value the browser sends. In a TanStack Start server
 * function: `new URL(request.url).origin`. In an Edge Function that URL is the backend's host, so
 * use an `APP_URL` secret with the published address there.
 * If the app has sign-in, load the order together with the caller's user id and refuse otherwise.
 */
export async function createMiaposPaymentForOrder(admin: any, orderId: string, language: "ro" | "ru" | "en", origin: string) {
  const { data: order, error } = await admin.from("orders")
    .select("id, description, total_mdl, payment_status").eq("id", orderId).single();
  if (error || !order) throw new Error("Order not found");
  if (order.payment_status === "paid") throw new Error("This order is already paid");
  if (order.payment_status === "review") throw new Error("This order is being checked by the shop");
  const total = Number(order.total_mdl);
  const handOut = (p: { payment_id: string; checkout_page: string }) =>
    ({ paymentId: p.payment_id, checkoutPage: p.checkout_page, baseUrl: miaposBaseUrl() });

  // Reuse the payment the buyer already has, so the same order is not paid twice.
  const open = await openPayment(admin, order.id, total);
  if (open) {
    if (Date.now() - Date.parse(open.created_at) < REUSE_MS) return handOut(open);
    await syncPayment(admin, open.payment_id);   // it may have expired: settle it before deciding
    const still = await openPayment(admin, order.id, total);
    if (still) return handOut(still);
  }

  const returnUrl = `${origin}/order/${order.id}`;
  const p = await createPayment({
    orderId: order.id, amount: total, description: order.description, language,
    callbackUrl: `${origin}/api/public/miapos/callback`, returnUrl,
  });
  const { error: insertError } = await admin.from("miapos_payments").insert({
    payment_id: p.paymentId, order_id: order.id, environment: miaposEnvironment(),
    amount: total, currency: "MDL", checkout_page: p.checkoutPage,
  });
  if (insertError?.code === "23505") {
    // A second request (a double click, two tabs) recorded its payment first: hand out that one.
    // Ours is never shown, and a payment nobody opens cannot be paid.
    const winner = await openPayment(admin, order.id, total);
    if (winner) return handOut(winner);
  }
  if (insertError) throw new Error(`Payment not recorded: ${insertError.message}`);   // no row, no redirect
  await admin.from("orders").update({ payment_status: "pending" }).eq("id", order.id).eq("payment_status", "unpaid");
  return handOut({ payment_id: p.paymentId, checkout_page: p.checkoutPage });
}
```

In the server function around it, log a `MiaposError` with the order id and return a plain message to the browser, such as "The payment could not be started. Try again." In the editor preview the callback cannot reach `origin`, which is fine: the status check settles the order.

## Callback

```ts
// file: API route POST /api/public/miapos/callback  (Edge Function in older apps, with JWT verification off)
import { isPaymentId, isValidCallbackSignature, type MiaposPayment } from "./miapos.server";
import { applyStatus } from "./miapos-orders.server";

const MAX_BODY = 16_384;
const reply = (status: number, text: string) => new Response(text, { status, headers: { "Content-Type": "text/plain" } });

export async function handleMiaposCallback(request: Request, admin: any): Promise<Response> {
  if (request.method !== "POST") return reply(405, "Method not allowed");
  const raw = await request.text();
  if (raw.length > MAX_BODY) return reply(413, "Payload too large");

  let body: any;
  try { body = JSON.parse(raw); } catch { return reply(400, "Bad request"); }
  const result = body?.result;
  if (!result || typeof result !== "object" || Array.isArray(result) || typeof body.signature !== "string") {
    return reply(400, "Bad request");
  }
  let valid: boolean;
  try { valid = await isValidCallbackSignature(result, body.signature); } catch (e) {
    console.error("miaPOS callback: public key unavailable", e instanceof Error ? e.message : String(e));
    return reply(503, "Try again");     // could not check: miaPOS retries with the same body
  }
  if (!valid) {
    console.warn("miaPOS callback rejected: bad signature", isPaymentId(result.paymentId) ? result.paymentId : "-");
    return reply(400, "Bad signature");
  }
  if (!isPaymentId(result.paymentId)) return reply(400, "Bad request");

  try {
    const outcome = await applyStatus(admin, result as MiaposPayment, "callback");
    console.info("miaPOS callback", result.paymentId, result.status, outcome);   // ids and outcome only
    return reply(200, "OK");            // also for duplicates and unknown payments: a retry would not help
  } catch (e) {
    console.error("miaPOS callback not applied", result.paymentId, e instanceof Error ? e.message : String(e));
    return reply(500, "Try again");     // not applied: miaPOS retries with the same body
  }
}
```

## Reconcile

```ts
// file: API route POST /api/public/miapos/reconcile, called by a scheduled job every minute.
// Lovable adds authenticateCronRequest(request) with LOVABLE_CRON_SECRET: reject anything else first.
import { miaposEnvironment } from "./miapos.server";
import { syncPayment } from "./miapos-orders.server";

const BATCH = 8;            // the job's call times out after a few seconds
const TIMEOUT_MS = 4_000;   // shorter than the usual 30 s on purpose: a slow check is retried next run
const MIN = 60_000;

/**
 * Up to BATCH payments to check, most urgent first: payments being paid, then fresh ones, then the ones
 * nobody opened. Those never expire, so they are checked every 10 minutes and cannot crowd out the rest.
 */
export async function duePayments(admin: any): Promise<string[]> {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const passes = [
    { status: "PENDING", since: ago(2 * 24 * 60 * MIN), recheck: ago(50_000) },
    { status: "CREATED", since: ago(15 * MIN), recheck: ago(50_000) },
    { status: "CREATED", since: ago(2 * 24 * 60 * MIN), recheck: ago(10 * MIN) },
  ];
  const ids: string[] = [];
  for (const pass of passes) {
    if (ids.length >= BATCH) break;
    const { data, error } = await admin.from("miapos_payments").select("payment_id")
      .eq("status", pass.status).eq("environment", miaposEnvironment()).gte("created_at", pass.since)
      .or(`checked_at.is.null,checked_at.lt.${pass.recheck}`)
      .order("checked_at", { ascending: true, nullsFirst: true }).limit(BATCH);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) if (ids.length < BATCH && !ids.includes(r.payment_id)) ids.push(r.payment_id);
  }
  return ids;
}

export async function reconcileMiaposPayments(admin: any) {
  const ids = await duePayments(admin);
  const results = await Promise.allSettled(ids.map((id) => syncPayment(admin, id, TIMEOUT_MS)));
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed) console.warn(`miaPOS reconcile: ${failed} of ${results.length} checks failed, retried next run`);
  return { checked: results.length, failed };
}
```

## Order status for the order page

```ts
// file: server function getOrderPayment({ orderId })
import { miaposEnvironment } from "./miapos.server";
import { latestPayment, syncPayment } from "./miapos-orders.server";

export async function getOrderPaymentState(admin: any, orderId: string) {
  let last = await latestPayment(admin, orderId);
  const stale = last && (!last.checked_at || Date.now() - Date.parse(last.checked_at) > 2_500);
  if (last && (last.status === "CREATED" || last.status === "PENDING") && stale) {
    try { await syncPayment(admin, last.payment_id, 8_000); } catch { /* keep the stored state; the job retries */ }
    last = await latestPayment(admin, orderId);
  }
  const { data: order, error } = await admin.from("orders").select("id, payment_status, paid_at").eq("id", orderId).single();
  if (error || !order) throw new Error("Order not found");
  return {
    orderStatus: order.payment_status as "unpaid" | "pending" | "paid" | "review",
    paymentStatus: last?.status ?? null,
    canRetry: order.payment_status === "unpaid" && !!last && ["FAILED", "DECLINED", "EXPIRED"].includes(last.status),
    testMode: miaposEnvironment() === "sandbox",   // show "Test payment, no real money" and do not fulfil
  };
}
```

## Admin list

```ts
// file: server function listMiaposPayments({ page, status })
import { listPayments, miaposEnvironment, type MiaposStatus } from "./miapos.server";

/** `caller` comes from the server-side role check (a `user_roles` table), never from the browser. */
export async function listPaymentsForAdmin(admin: any, caller: { isAdmin: boolean }, page = 0, status?: MiaposStatus) {
  if (!caller.isAdmin) throw new Error("Not allowed");
  const list = await listPayments({ page, size: 50, paymentStatus: status });
  const ids = list.payments.map((p) => p.paymentId);
  const { data, error } = ids.length
    ? await admin.from("miapos_payments").select("payment_id, review_reason").in("payment_id", ids)
    : { data: [], error: null };
  if (error) throw new Error(error.message);
  const own = new Map<string, string | null>((data ?? []).map((r: any) => [r.payment_id, r.review_reason]));
  // The sandbox test merchant is shared: keep only this app's own payments there (a page can come back short).
  const sandbox = miaposEnvironment() === "sandbox";
  const payments = list.payments
    .filter((p) => !sandbox || own.has(p.paymentId))
    .map((p) => ({ ...p, reviewReason: own.get(p.paymentId) ?? null }));
  return { ...list, payments };
}

/**
 * After checking the payment in the miaPOS Merchant Portal (and refunding there if needed), the admin
 * settles the order. Server code with the service role, like everything that writes orders.
 */
export async function resolveReview(admin: any, caller: { isAdmin: boolean }, paymentId: string, orderStatus: "paid" | "unpaid") {
  if (!caller.isAdmin) throw new Error("Not allowed");
  const { data: pay, error } = await admin.from("miapos_payments").select("order_id, review_reason").eq("payment_id", paymentId).single();
  if (error || !pay?.review_reason) throw new Error("Nothing to review for this payment");
  const { data: order } = await admin.from("orders").select("payment_status").eq("id", pay.order_id).single();
  if (orderStatus === "unpaid" || order?.payment_status !== "paid") {
    const { error: e } = await admin.from("orders")
      .update(orderStatus === "paid" ? { payment_status: "paid", paid_at: new Date().toISOString() } : { payment_status: "unpaid", paid_at: null })
      .eq("id", pay.order_id);
    if (e) throw new Error(e.message);
  }
  const { error: e2 } = await admin.from("miapos_payments").update({ review_reason: null }).eq("payment_id", paymentId);
  if (e2) throw new Error(e2.message);
}

/** Payments a person must look at: a wrong amount, a double payment, a success after a failure. */
export async function listPaymentsNeedingReview(admin: any, caller: { isAdmin: boolean }) {
  if (!caller.isAdmin) throw new Error("Not allowed");
  const { data, error } = await admin.from("miapos_payments")
    .select("payment_id, order_id, amount, status, review_reason, updated_at")
    .in("review_reason", ["amount_mismatch", "paid_twice", "late_success"])
    .order("updated_at", { ascending: false }).limit(100);
  if (error) throw new Error(error.message);
  return data ?? [];
}
```

## Widget

```tsx
// file: src/components/MiaposWidget.tsx  (browser)
import { useEffect, useRef } from "react";

type Mounted = { destroy(): void };
declare global {
  interface Window { miaPOS?: { version: string; mount(el: Element, opts: Record<string, unknown>): Mounted } }
}

const loading = new Map<string, Promise<void>>();

function loadWidget(baseUrl: string): Promise<void> {
  const src = `${baseUrl}/js/v1/miapos.js`;
  let p = loading.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("miaPOS widget did not load"));
      document.head.appendChild(s);
    });
    p.catch(() => loading.delete(src));
    loading.set(src, p);
  }
  return p;
}

export function MiaposWidget(props: {
  payment: { paymentId: string; checkoutPage: string; baseUrl: string };
  locale: "ro" | "ru" | "en";
  onFinished: () => void;          // ask the server for the order status; never trust the widget alone
}) {
  const host = useRef<HTMLDivElement>(null);
  const onFinished = useRef(props.onFinished);
  onFinished.current = props.onFinished;

  useEffect(() => {
    let widget: Mounted | undefined;
    let cancelled = false;
    const fallback = () => { if (!cancelled) window.location.assign(props.payment.checkoutPage); };
    loadWidget(props.payment.baseUrl).then(() => {
      if (cancelled || !host.current) return;
      if (!window.miaPOS) return fallback();             // browser without Shadow DOM or fetch
      widget = window.miaPOS.mount(host.current, {
        paymentId: props.payment.paymentId, locale: props.locale, directRedirect: true,
        onSuccess: () => onFinished.current(), onFail: () => onFinished.current(),
      });
    }, fallback);
    return () => { cancelled = true; widget?.destroy(); };
  }, [props.payment.paymentId, props.payment.baseUrl, props.payment.checkoutPage, props.locale]);

  return <div ref={host} />;
}
```

The widget polls the bank host's public status endpoint by itself, which answers any origin (CORS). On a phone, "Choose your bank" opens the banking app. The server checked that `checkoutPage` is on the bank host before handing it out.
