# Protocol stress test: can `{ input, output }` express real requests?

> **Status: the structured protocol tested here was dropped on 2026-11-20.**
> v1 keeps the free-text `{ intent, input, output }` format (PLAN.md §4).
> The cases stay as benchmark material: almost all of them can be written as
> an intent, and the ambiguous ones (#18, #19, #23) are the cases the
> dictionary's glossary and rules (§4.4) should make reliable.
>
> Rule numbers here (R8, R12, R13–R19) refer to the dropped protocol's
> PLAN.md §4, kept in git history. Today's R1–R11 are different rules.

* **Date:** 2026-11-20
* **Protocol under test:** PLAN.md §4 (`input`: `from`, `where`, `orderBy`,
  `limit`, `offset`; `output`: shape notation; names are the caller's words)
* **Schema:** the demo database (`sandbox/db/init.sql`): `plans`, `accounts`,
  `subscriptions`, `invoices`, `usage_events`.

Verdicts:

* **✅ works:** works with the protocol as it is.
* **⚠️ ambiguous:** can be written, but the model has to guess.
* **❌ can't express:** can't be written yet.
* **➕ proposed change:** the change (I-numbers, §3) that fixes it.

## 1. Cases

### Lists and single records

| # | Request | Written as | Verdict |
|---|---|---|---|
| 1 | Accounts in Germany, newest first, 20 | `from: accounts, where: {country: "DE"}, orderBy: [{createdAt: desc}], limit: 20` → `[{name, email, createdAt}]` | ✅ |
| 2 | One account by id | `where: {id: 42}` → `{name, email, plan}` | ⚠️ Says nothing about zero or two rows. ➕ I4 |
| 3 | Account with its invoices | `where: {id: 42}` → `{name, invoices: [{amount, status, issuedAt}]}` | ✅ nested shape |
| 4 | Dropdown of all countries | → `["string"]` | ⚠️ A bare `"string"` has no name, so nothing says what it is. ➕ I4 (every leaf is named): `{countries: ["string"]}` or `[{country}]` |
| 5 | Page 3 of a table plus total count | → `{total: "integer", items: [{…}]}`, `limit: 20, offset: 40` | ❌ `limit` would apply to the whole response, not to `items`. ➕ I3 |

### Filters

| # | Request | Written as | Verdict |
|---|---|---|---|
| 6 | Invoices issued in Q1 | `where: {issuedAt: {gte: "2026-01-01", lt: "2026-04-01"}}` | ✅ if several operators on one name are allowed (AND). ➕ I5 states it |
| 7 | Accounts on plan pro or team | `where: {plan: {in: ["pro", "team"]}}` | ✅ |
| 8 | Accounts not in DE or FR | `where: {country: {notIn: [...]}}` | ❌ no `notIn`. ➕ I5 |
| 9 | Name contains "acme" | `where: {name: {contains: "acme"}}` | ⚠️ Case sensitivity is undefined. ➕ I5: case-insensitive |
| 10 | Invoices of German accounts | `from: invoices, where: {country: "DE"}` | ✅ The model joins to `accounts`. `account.country` also works as a name |
| 11 | Canceled subscriptions | `where: {status: "cancelled"}` | ⚠️ The value is spelled `canceled` in the DB, and the model never sees values, so it can't correct the spelling. Names are fuzzy; values must be exact. ➕ I6 |
| 12 | Optional dashboard filter left empty | `where: {country: null}` | ✅ dropped (R8) |
| 13 | Accounts with no subscription | `where: {subscription: {isNull: true}}` | ⚠️ Works if the model reads it as "no related row". Mapping shown in `meta.mapping` |
| 14 | Accounts with a failed invoice | `where: {hasFailedInvoice: true}` → `[{name}]` | ✅ The model writes an `EXISTS` |
| 15 | Accounts in DE **or** on plan pro | — | ❌ no `or`. Kept out of v1 (R12) |
| 16 | Activity in the last 30 days | `where: {occurredAt: {gte: "<date the client computed>"}}` | ✅ The client computes the date. Relative dates are not in v1 |

### Grouping and aggregates

| # | Request | Written as | Verdict |
|---|---|---|---|
| 17 | Accounts per plan | `from: accounts` → `[{plan: "string", accounts: "integer"}]` | ✅ An `integer` next to a label reads as a count |
| 18 | Plans with their monthly price | → `[{plan: "string", price: "integer"}]` | ⚠️ Same shape as #17, but here nothing is grouped. Shape alone can't tell a dimension from an aggregate. ➕ I1 |
| 19 | Revenue per month since a date | `where: {paidAt: {gte: …}}` → `[{month: "string", revenue: "integer"}]` | ⚠️ "month" is a guess from the name, and "revenue" may mean paid only, all invoices, or MRR. ➕ I1 (time buckets), I7 (meaning) |
| 20 | Same chart, user switches day/week/month | — | ⚠️ A new handler per granularity. ➕ I1: granularity is a value |
| 21 | Plans with more than 10 accounts | `where: {accounts: {gt: 10}}` → `[{plan, accounts}]` | ⚠️ Is it a filter on rows or on the count (`HAVING`)? ➕ I2 |
| 22 | Dashboard tiles: total accounts, MRR, failed invoices | → `{accounts: "integer", mrr: "integer", failedInvoices: "integer"}` | ✅ A single row from several tables. `from` can be left out |
| 23 | Failed-invoice rate per country | → `[{country, failedRate: "number"}]` | ⚠️ 0–1 or 0–100? ➕ I7 |
| 24 | Latest invoice date per account | → `[{account, lastInvoiceAt}]` | ✅ `max` |
| 25 | Top 3 accounts by paid amount **in each plan** | → `[{plan, accounts: [{name, totalPaid}]}]` | ❌ `orderBy` and `limit` apply only to the top level. ➕ I3 |
| 26 | Running total of revenue by month | → `[{month, revenue, cumulativeRevenue}]` | ✅ The model writes a window function |

### Sorting and paging

| # | Request | Written as | Verdict |
|---|---|---|---|
| 27 | Sort by a field not in the output | `orderBy: [{createdAt: desc}]`, `createdAt` not in `output` | ✅ The R11 sort check is skipped |
| 28 | User clicks column headers to sort | `orderBy` changes per click | ⚠️ One handler per column and direction. Column names can't be bound as parameters safely, so this is accepted: each handler is generated once |
| 29 | Infinite scroll (cursor) | — | ❌ Use `offset` in v1 |

### Values, types, units

| # | Request | Written as | Verdict |
|---|---|---|---|
| 30 | Amounts in euros, not cents | → `{totalPaidEur: "number"}` | ✅ The unit is in the name, and the model divides by 100. Shown in `meta.mapping` |
| 31 | Dates as `YYYY-MM-DD` | → `{createdAt: "string"}` | ⚠️ Format undefined: ISO date-time, date only, or locale. ➕ I4: `date` and `datetime` leaves |
| 32 | id sent as `"42"` vs `42` | — | ✅ Two handlers (string vs number). Acceptable |

### Safety and nonsense

| # | Request | Written as | Verdict |
|---|---|---|---|
| 33 | Emails with password hashes | → `[{email, passwordHash}]` | ✅ `FIELD_NOT_FOUND`: the model never sees the column. **Risk:** the model maps `passwordHash` to some *other* visible column. Prompt rule: map only on a real match in meaning; the review checks the mapping |
| 34 | Delete canceled subscriptions | — | ✅ Can't be expressed at all: the protocol has no verbs. Safer than the sandbox, where the intent text could ask for it |
| 35 | Two unrelated lists in one call | → `{plans: [...], countries: [...]}` | ✅ One SQL with subqueries. Allowed, but separate requests are simpler |

## 2. What the cases show

1. **Most requests fit.** Of the 35 cases:
   * 18 work as is;
   * 12 can be written but leave the model guessing. Changes I1–I7 fix 10 of
     them; #13 and #28 stay as accepted costs;
   * 5 can't be written. I3 and I5 fix three (#5, #8, #25); `or` (#15) and
     cursor paging (#29) stay out of v1.
2. **Grouping is the weak spot (#17–#21, #25).** Shape alone can't separate
   "group by plan, count accounts" from "plans with their price".
3. **Names are fuzzy, values are not (#11).** The model sees names, never
   values. Value mistakes must be caught without the model.
4. **The meaning of a measure (#19, #23) is where answers go wrong.** In the
   sandbox benchmark this was the churn case. Meaning is usually the same
   for the whole app, not one request.
5. **`limit` and `orderBy` must be able to point inside the output (#5,
   #25).**
6. **No verbs means no writes (#34).** The structured protocol is safer than
   free text.

## 3. Proposed changes

All seven were accepted on 2026-11-20 and are in PLAN.md §4: I1 → R14, I2 →
R13, I3 → R15, I4 → R16, I5 → R17, I6 → R18, I7 → R19.

| # | Change | Fixes |
|---|---|---|
| I1 | **`groupBy`** in `input`: a list of `output` names. Every other output field is then an aggregate. An entry can be a time bucket, `{ "month": "month" }` (output name → `day` \| `week` \| `month` \| `quarter` \| `year`); the granularity is a **value**, bound as a parameter (`date_trunc($1, …)`), so one handler serves all granularities. Without `groupBy` the model infers it, and `meta.mapping` says what it chose. | #17–#20 |
| I2 | **`where` on an aggregate:** a `where` name that is also an aggregated `output` name filters groups (`HAVING`). | #21 |
| I3 | **Paths in `orderBy` and `limit`:** `orderBy: [{"accounts.totalPaid": "desc"}]`, and `limit` is a number (top level) or `{ "items": 20, "accounts": 3 }` (per list, by output path). | #5, #25 |
| I4 | **Output rules:** a top-level object means one row (`data` is `null` when there's none; more than one is an error); a top-level list means rows; every leaf sits under a name; new leaves `"date"` (`YYYY-MM-DD`) and `"datetime"` (ISO 8601), checked like the others. | #2, #4, #31 |
| I5 | **Operators:** `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`, `contains` (case-insensitive), `startsWith`, `isNull`. Several operators on one name are combined with AND. `in: []` matches nothing. | #6, #8, #9 |
| I6 | **Exact values, checked without the model:** the connector reads the allowed values of enum-like columns (Postgres enums and `CHECK … IN (…)`) into the schema. Slime checks `where` values against them before running and returns `INVALID_VALUE` with the allowed list. The model sees the allowed values (they're schema, not request data), so it can write correct literals. | #11 |
| I7 | **App glossary in `SlimeConfig`:** `glossary: { revenue: "sum of paid invoices, in cents", failedRate: "0–1" }`. Written once per app, sent to the model with the schema, and part of the cache key through a glossary hash. It covers most of what `intent` was meant for; per-request `intent` stays a later addition. | #19, #23, churn |

Left out of v1: `or` (#15), cursor paging (#29), relative dates (#16),
parameterized sort columns (#28).

## 4. Describing the protocol for people and agents

Yes, this is a typed protocol: free in its names, strict in its structure.
Ship it in three forms, all generated from one definition in core:

1. **TypeScript types** (`SlimeRequest`, `Shape`) exported from
   `@slime-cloud/core`. `slime.query()` also infers the type of `data` from a
   literal `output`:

   ```ts
   const { data } = await slime.query({
     input: { from: 'accounts', limit: 5 },
     output: [{ name: 'string', totalPaid: 'integer' }] as const,
   });
   // data: { name: string; totalPaid: number }[]
   ```

2. **JSON Schema** (`@slime-cloud/core/request.schema.json`). Validates
   requests in any language, and gives editors autocomplete. Agents can use
   it as a tool input schema.
3. **`PROTOCOL.md`**: the rules plus the examples from §1, written so a
   coding agent can build a frontend's requests from it without reading
   the source. It could also ship as `llms.txt`.
