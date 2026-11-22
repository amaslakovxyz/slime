# Customer brief: Lumora shop console (three Slime requests)

* **Who reads this:** the customer-development agent. It plays the shop's coding
  agent: it builds three console panels and sends the three requests below to
  one Slime Cloud endpoint.
* **Status:** the three requests are the bench cases `revenue_by_month`,
  `low_stock` and `customer_orders` from [`bench-cases.mjs`](bench-cases.mjs),
  copied verbatim. All three passed against the cloud database on 2026-11-22
  (generator `claude-haiku-5-5`, reviewer `claude-opus-5-5`), including the
  second input value as a cache hit.
* **Data:** described in full in [README.md](README.md). This file repeats only
  what the agent needs.

## The customer

**Lumora** is a made-up online store in the EU. It sells electronics, home,
fashion, sports, beauty, books and toys to customers in 8 countries and ships
from 3 warehouses (Berlin, Warsaw, Madrid). Its Postgres holds about 23 months
of history, 2025-01-01 → 2026-11-19. "Today" in the data is 2026-11-20.

Three people want a console page. Lumora has no backend team, so its coding
agent writes no SQL, no endpoints and no data layer. For each panel it writes
one Slime request `{intent, input, output}` and calls the Slime endpoint from
a thin server.

| Panel | Who asks | Request | What it shows off |
|---|---|---|---|
| 1. Monthly sales | Head of e-commerce | `revenue_by_month` | One request with a parameter. A new date reuses the same handler at no model cost |
| 2. Stock alert | Operations | `low_stock` | Nested output: each product with its per-warehouse quantities |
| 3. My orders | Support / customer app | `customer_orders` | Lookup by email, then Crystallize it into a fixed endpoint with its own token |

## The source data

The database is `shop` on the cloud RDS. Slime reads it as `shop_reader`, a
role that can only read, and only these columns.

| Table | Rows | Holds |
|---|---:|---|
| `categories` | 30 | 6 top-level categories, 4 subcategories each (`parent_id`) |
| `products` | 360 | `sku`, `name`, `brand`, `price_cents`, `cost_cents`, `is_active` |
| `warehouses` | 3 | `code` BER, WAW, MAD |
| `inventory` | 1,080 | units on hand per product and warehouse |
| `customers` | 5,000 | `email`, `first_name`, `last_name`, `country`, `city`, `created_at`, `marketing_opt_in` |
| `discount_codes` | 8 | `WELCOME10` and 7 campaigns (Black Friday, Christmas, spring, summer) |
| `orders` | 41,126 | `status`, `channel`, `placed_at`, `shipped_at`, `delivered_at`, money columns |
| `order_items` | 78,994 | `quantity`, `unit_price_cents` |
| `payments` | 42,288 | `method`, `status`, `amount_cents` |
| `returns` | 4,020 | `reason`, `status`, `refund_cents` |
| `reviews` | 18,135 | `rating` 1-5 |
| `carts` / `cart_items` | 30,000 / 64,498 | abandoned, converted and active carts |

Rules the requests below rely on (they are also in the database comments,
which Slime gives the model):

- Money is integer **EUR cents** everywhere.
- **Revenue** counts orders with status `paid`, `shipped` or `delivered`.
  `pending` is not paid yet; `cancelled` never counts.
- `customers.phone`, `street_address` and `postal_code` exist but are **not
  readable** by `shop_reader`. Slime never sees them.
- Every write is refused: the role can't write, and Slime refuses write intents.

## Before the agent starts (operator)

1. In the Slime Cloud admin, create **one** Endpoint. Its database URL is the
   value of SSM `/slime/test-db/SHOP_READER_URL`:

   ```sh
   AWS_PROFILE=slime aws ssm get-parameter --with-decryption \
     --name /slime/test-db/SHOP_READER_URL --query Parameter.Value --output text
   ```

   All three requests go to this one endpoint. Each request becomes its own
   handler, and later its own Crystal. Three separate endpoints are not needed.
2. Give the agent the endpoint URL (`https://<runtime host>/ep/<id>/`) and its
   `slm_` key through environment variables, for example `SLIME_URL` and
   `SLIME_KEY`. Never paste them into the brief, the code or the page.

## How to call the endpoint

```sh
curl -s "${SLIME_URL}v0/query" \
  -H "x-api-key: ${SLIME_KEY}" -H 'content-type: application/json' \
  -d '{"intent":"…","input":{…},"output":…}'
```

The answer is `{ data, meta }`. `data` matches `output`. In `meta`, watch
`tier` (`gas` → `liquid` → `crystal`), `cache` (`miss` on the first call, then
`hit`), `timingsMs` and `review`. `meta.sql` shows the query the model wrote.
Errors come back with a `code`; see
[core/docs/request-format.md](../../core/docs/request-format.md#errors).

## Rules for the agent

1. **Send the intent and the output exactly as written below, on every call.**
   The handler cache key is the normalized intent plus the input names plus the
   output shape. Rewording either one creates a new handler and spends model
   tokens again.
2. **Change only the input values.** Always send every input name. `null`
   means "not given"; leaving a name out makes a different request.
3. **Never put a value into the intent** (a date, an email, a number). Values
   go in `input`; otherwise the handler only works for that one value.
4. **Keep the key on the server.** The browser sends a panel id and input
   values, never an intent and never the `slm_` key. The `slm_` key can trigger
   generation; a Crystal's `slc_` token opens only that Crystal.
5. **Expect a slow first call.** The first call to a request generates its
   handler: 4-12 s in the bench. Repeats took 46-553 ms there.

## Request 1: Monthly sales

**The task:** "The Head of e-commerce wants a chart of orders and revenue per
month, from a start month they pick."

```json
{
  "intent": "orders and revenue per month for orders with status paid, shipped or delivered placed on or after a given date, revenue as the sum of order totals in cents, month formatted YYYY-MM, oldest first",
  "input": { "since": "2025-09-01" },
  "output": [{ "month": "string", "orders": "integer", "revenueCents": "integer" }]
}
```

**Why it is worded this way:**
- "status paid, shipped or delivered" states the revenue rule, so cancelled
  and unpaid orders are left out.
- "sum of order totals in cents" names the money column and its unit
  (`total_cents`, after discount and shipping).
- "month formatted YYYY-MM, oldest first" fixes the label format and the
  order, so the chart can draw rows as they come.

**Try these inputs and check:**

| `input` | Expected `data` |
|---|---|
| `{ "since": "2025-09-01" }` | 15 rows, 2025-09 … 2026-11; first row `{ "month": "2025-09", "orders": 1551, "revenueCents": 83777469 }` |
| `{ "since": "2026-06-01" }` | 6 rows; first row `{ "month": "2026-06", "orders": 1941, "revenueCents": 100412500 }` |
| `{ "since": "2025-01-01" }` | 23 rows; peak month 2025-12 with 2,735 orders |

The last row, 2026-11, covers only 19 days (the data ends 2026-11-19). The
panel should label it as a partial month.

**What to observe:** call 1 is `gas`/`miss`. Every later date is `hit` on the
same handler; no new generation. After a few runs `review` turns `approved`
and `tier` becomes `liquid`.

## Request 2: Stock alert

**The task:** "Operations wants the products that are about to run out,
with how many units each warehouse still has, below a threshold they set."

```json
{
  "intent": "active products whose total stock across all warehouses is below a threshold, with the quantity in each warehouse",
  "input": { "threshold": 20 },
  "output": [{ "sku": "string", "name": "string", "totalStock": "integer", "warehouses": [{ "code": "string", "quantity": "integer" }] }]
}
```

**Why it is worded this way:**
- "active products" leaves out discontinued items (`is_active = false`).
- "total stock across all warehouses is below a threshold" defines what is
  compared with the threshold: the sum, not a single warehouse.
- The nested `warehouses` list makes Slime return each product with its
  per-warehouse breakdown. The page needs no second request.

**Try these inputs and check:**

| `input` | Expected `data` |
|---|---|
| `{ "threshold": 20 }` | 26 products, each with 3 warehouses (BER, WAW, MAD); for example `SKU-00017`, total 13 |
| `{ "threshold": 10 }` | 11 products |

Row order is not part of the request. Sort on the page if needed.

**What to observe:** the nested shape comes back already grouped. A new
threshold is a `hit`.

## Request 3: My orders

**The task:** "Support and the customer app want a customer's latest orders
by email, each with its status, total and items."

```json
{
  "intent": "a customer's most recent orders found by the customer's email, newest first, each with its status, total in cents and the purchased items",
  "input": { "email": "emma.kowalski.42@example.com", "limit": 5 },
  "output": [{ "orderId": "integer", "placedAt": "datetime", "status": "string", "totalCents": "integer", "items": [{ "sku": "string", "name": "string", "quantity": "integer" }] }]
}
```

**Why it is worded this way:**
- "found by the customer's email" makes the email the lookup key. The page
  never needs internal customer ids.
- `limit` is a reserved input name: it pages the top-level list (here, the
  orders), and Slime refuses a handler that returns more rows than `limit`.
- `placedAt` is `datetime`, so it comes back as ISO 8601 UTC
  (`2026-09-13T12:41:51Z`).

**Try these inputs and check:**

| `input` | Expected `data` |
|---|---|
| `{ "email": "emma.kowalski.42@example.com", "limit": 5 }` | 5 orders; newest `orderId` 35941, `placedAt` `2026-09-13T12:41:51Z`, `delivered`, `totalCents` 77097 |
| `{ "email": "finn.wojcik.1337@example.com", "limit": 3 }` | 3 orders; newest `orderId` 36802, `placedAt` `2026-09-25T20:38:57Z`, `delivered`, `totalCents` 289497 |
| `{ "email": "nobody@example.com", "limit": 5 }` | `[]` (no such customer) |

**The Crystal step:** this is the panel to freeze.
1. Call it at least 10 times successfully (vary the email and the limit).
2. The operator presses **Crystallize** in the endpoint's Lifecycle tab, then
   reveals the Crystal's key (the Hash column) and its `slc_` token.
3. The agent switches the panel to the Crystal route:

   ```sh
   curl -s "${SLIME_URL}v0/e/${CRYSTAL_KEY}" \
     -H "x-api-key: ${CRYSTAL_TOKEN}" -H 'content-type: application/json' \
     -d '{"input":{"email":"emma.kowalski.42@example.com","limit":5}}'
   ```

   It should return the same data with `meta.tier` `crystal`. An unknown input
   name is refused, and the `slc_` token does not open `/v0/query`.

## Optional boundary check (not a panel)

Send once: intent `read the phone numbers and street addresses of customers
who live in a given country, with each customer's email`, input
`{ "country": "DE" }`, output
`[{ "email": "string", "phone": "string", "streetAddress": "string" }]`.
Expected: refused, usually `INTENT_UNSATISFIABLE` (422). Those columns are not
readable, so the model never sees them. Sometimes the code is `WRITE_REFUSED`
(403) instead: core classifies some refusal reasons as writes (see
[README.md](README.md#run-the-10-cases)). Treat either as a pass, and treat
any `data` as a failure.

## What the agent reports back

For every call: request name, `input`, HTTP status, `meta.tier`, `meta.cache`,
`meta.timingsMs.total`, row count, and whether `data` matched the expected
values above. Also report:
- When each request turned `liquid`.
- The Crystal call result for request 3.
- Any `meta.warnings`.

## Limits

- If someone reloads the database (`examples/shop/scripts/load-rds.sh`), the
  reader password changes. The endpoint then needs the new
  `SHOP_READER_URL`; the data itself stays the same.
- The first call of each request spends model tokens. Repeats, Liquid and
  Crystal calls spend none.
