// Bench requests against the demo shop database (examples/shop/db/shop.sql).
// They double as the 10 demo use cases in examples/shop/README.md, which copies
// the requests verbatim. Run them with
//   BENCH_CASES=examples/shop/bench-cases.mjs npm run bench -w @slime-cloud/core
// A checked case has a hand-written reference query; the bench compares Slime's
// answer to it for the input and for a second input value, which must be a cache
// hit (the handler is parameterized, not copied values).

/** @typedef {(sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>} RunSql */

const SOLD = "('paid', 'shipped', 'delivered')";

export const cases = [
  {
    kind: 'checked',
    name: 'sales_kpis',
    intent:
      'sales summary for orders placed on or after a start date and before an end date, counting only orders with status paid, shipped or delivered: number of orders, revenue as the sum of order totals in cents, number of distinct customers, and average order value in cents rounded to the nearest integer',
    input: { from: '2026-10-01', to: '2026-11-01' },
    altInput: { from: '2025-11-24', to: '2025-12-02' },
    output: { orders: 'integer', revenueCents: 'integer', customers: 'integer', avgOrderValueCents: 'integer' },
    isOrdered: false,
    /** @param {RunSql} run */
    expected: async (run, input) =>
      (
        await run(
          `SELECT count(*)::int AS orders, coalesce(sum(total_cents), 0)::bigint AS "revenueCents",
                  count(DISTINCT customer_id)::int AS customers, round(avg(total_cents))::int AS "avgOrderValueCents"
           FROM orders WHERE status IN ${SOLD} AND placed_at >= $1::timestamptz AND placed_at < $2::timestamptz`,
          [input.from, input.to],
        )
      )[0] ?? null,
  },
  {
    kind: 'checked',
    name: 'revenue_by_month',
    intent:
      'orders and revenue per month for orders with status paid, shipped or delivered placed on or after a given date, revenue as the sum of order totals in cents, month formatted YYYY-MM, oldest first',
    input: { since: '2025-09-01' },
    altInput: { since: '2026-06-01' },
    output: [{ month: 'string', orders: 'integer', revenueCents: 'integer' }],
    isOrdered: true,
    expected: (run, input) =>
      run(
        `SELECT to_char(date_trunc('month', placed_at), 'YYYY-MM') AS month, count(*)::int AS orders, sum(total_cents)::bigint AS "revenueCents"
         FROM orders WHERE status IN ${SOLD} AND placed_at >= $1::timestamptz GROUP BY 1 ORDER BY 1`,
        [input.since],
      ),
  },
  {
    kind: 'checked',
    name: 'top_products_in_category',
    intent:
      'top N products by revenue in cents (quantity times unit price) from orders with status paid, shipped or delivered placed on or after a given date, within one top-level category including all of its subcategories, highest revenue first',
    input: { category: 'Electronics', since: '2026-01-01', limit: 5 },
    altInput: { category: 'Fashion', since: '2025-11-01', limit: 10 },
    output: [{ sku: 'string', name: 'string', subcategory: 'string', unitsSold: 'integer', revenueCents: 'integer' }],
    isOrdered: true,
    expected: (run, input) =>
      run(
        `SELECT p.sku, p.name, sub.name AS subcategory, sum(oi.quantity)::int AS "unitsSold",
                sum(oi.quantity * oi.unit_price_cents)::bigint AS "revenueCents"
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN products p ON p.id = oi.product_id
         JOIN categories sub ON sub.id = p.category_id
         JOIN categories top ON top.id = sub.parent_id
         WHERE o.status IN ${SOLD} AND o.placed_at >= $2::timestamptz AND top.name = $1::text
         GROUP BY p.id, p.sku, p.name, sub.name ORDER BY "revenueCents" DESC LIMIT $3::int`,
        [input.category, input.since, input.limit],
      ),
  },
  {
    kind: 'checked',
    name: 'low_stock',
    intent: 'active products whose total stock across all warehouses is below a threshold, with the quantity in each warehouse',
    input: { threshold: 20 },
    altInput: { threshold: 10 },
    output: [{ sku: 'string', name: 'string', totalStock: 'integer', warehouses: [{ code: 'string', quantity: 'integer' }] }],
    isOrdered: false,
    expected: async (run, input) => {
      const rows = await run(
        `WITH t AS (SELECT product_id, sum(quantity)::int AS total FROM inventory GROUP BY product_id HAVING sum(quantity) < $1::int)
         SELECT p.sku, p.name, t.total, w.code, i.quantity
         FROM t
         JOIN products p ON p.id = t.product_id AND p.is_active
         JOIN inventory i ON i.product_id = p.id
         JOIN warehouses w ON w.id = i.warehouse_id`,
        [input.threshold],
      );
      const bySku = new Map();
      for (const { sku, name, total, code, quantity } of rows) {
        const product = bySku.get(sku) ?? { sku, name, totalStock: total, warehouses: [] };
        product.warehouses.push({ code, quantity });
        bySku.set(sku, product);
      }
      return [...bySku.values()];
    },
  },
  {
    kind: 'checked',
    name: 'customer_orders',
    intent: "a customer's most recent orders found by the customer's email, newest first, each with its status, total in cents and the purchased items",
    input: { email: 'emma.kowalski.42@example.com', limit: 5 },
    altInput: { email: 'finn.wojcik.1337@example.com', limit: 3 },
    output: [
      { orderId: 'integer', placedAt: 'datetime', status: 'string', totalCents: 'integer', items: [{ sku: 'string', name: 'string', quantity: 'integer' }] },
    ],
    isOrdered: true,
    expected: async (run, input) => {
      const rows = await run(
        `WITH o AS (
           SELECT o.id, o.placed_at, o.status, o.total_cents FROM orders o JOIN customers c ON c.id = o.customer_id
           WHERE c.email = $1::text ORDER BY o.placed_at DESC LIMIT $2::int
         )
         SELECT o.id AS "orderId", to_char(o.placed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "placedAt",
                o.status, o.total_cents AS "totalCents", p.sku, p.name, oi.quantity
         FROM o JOIN order_items oi ON oi.order_id = o.id JOIN products p ON p.id = oi.product_id
         ORDER BY o.placed_at DESC`,
        [input.email, input.limit],
      );
      const byOrder = new Map();
      for (const { orderId, placedAt, status, totalCents, sku, name, quantity } of rows) {
        const order = byOrder.get(orderId) ?? { orderId, placedAt, status, totalCents, items: [] };
        order.items.push({ sku, name, quantity });
        byOrder.set(orderId, order);
      }
      return [...byOrder.values()];
    },
  },
  {
    kind: 'checked',
    name: 'abandoned_carts',
    intent:
      "abandoned carts of customers who opted in to marketing, last updated on or after a given date, whose value (quantity times unit price) is at least a minimum in cents, with the customer's email, the day the cart was abandoned, the cart value in cents and the number of units, highest value first",
    input: { since: '2026-11-01', minValueCents: 20000 },
    altInput: { since: '2026-10-15', minValueCents: 50000 },
    output: [{ email: 'string', abandonedOn: 'date', cartValueCents: 'integer', units: 'integer' }],
    isOrdered: false,
    expected: (run, input) =>
      run(
        `SELECT c.email, to_char(ca.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "abandonedOn",
                sum(ci.quantity * ci.unit_price_cents)::bigint AS "cartValueCents", sum(ci.quantity)::int AS units
         FROM carts ca
         JOIN customers c ON c.id = ca.customer_id
         JOIN cart_items ci ON ci.cart_id = ca.id
         WHERE ca.status = 'abandoned' AND c.marketing_opt_in AND ca.updated_at >= $1::timestamptz
         GROUP BY ca.id, c.email, ca.updated_at
         HAVING sum(ci.quantity * ci.unit_price_cents) >= $2::int`,
        [input.since, input.minValueCents],
      ),
  },
  {
    kind: 'checked',
    name: 'discount_code_performance',
    intent:
      'for each discount code used on orders with status paid, shipped or delivered placed on or after a given date: its percent off, number of orders, total discount given in cents and revenue as the sum of order totals in cents, most orders first',
    input: { since: '2025-11-01' },
    altInput: { since: '2026-06-01' },
    output: [{ code: 'string', percentOff: 'integer', orders: 'integer', discountCents: 'integer', revenueCents: 'integer' }],
    isOrdered: false,
    expected: (run, input) =>
      run(
        `SELECT d.code, d.percent_off AS "percentOff", count(*)::int AS orders,
                sum(o.discount_cents)::bigint AS "discountCents", sum(o.total_cents)::bigint AS "revenueCents"
         FROM orders o JOIN discount_codes d ON d.id = o.discount_code_id
         WHERE o.status IN ${SOLD} AND o.placed_at >= $1::timestamptz
         GROUP BY d.id, d.code, d.percent_off`,
        [input.since],
      ),
  },
  {
    kind: 'checked',
    name: 'refund_rate_by_category',
    intent:
      'for each top-level product category, for delivered orders placed on or after a given date: units sold, units refunded through returns with status refunded, and the refund rate in percent (refunded units divided by sold units times 100) rounded to 2 decimals',
    input: { since: '2025-01-01' },
    altInput: { since: '2026-01-01' },
    output: [{ category: 'string', unitsSold: 'integer', unitsRefunded: 'integer', refundRatePct: 'number' }],
    isOrdered: false,
    // returns.order_item_id is UNIQUE, so the LEFT JOIN never double counts sum(oi.quantity).
    expected: (run, input) =>
      run(
        `SELECT top.name AS category, sum(oi.quantity)::int AS "unitsSold", coalesce(sum(r.quantity), 0)::int AS "unitsRefunded",
                round(100.0 * coalesce(sum(r.quantity), 0) / sum(oi.quantity), 2) AS "refundRatePct"
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id AND o.status = 'delivered' AND o.placed_at >= $1::timestamptz
         JOIN products p ON p.id = oi.product_id
         JOIN categories sub ON sub.id = p.category_id
         JOIN categories top ON top.id = sub.parent_id
         LEFT JOIN returns r ON r.order_item_id = oi.id AND r.status = 'refunded'
         GROUP BY top.name`,
        [input.since],
      ),
  },
  {
    kind: 'checked',
    name: 'repeat_customers_by_cohort',
    intent:
      'customers grouped by signup month, for customers who signed up on or after a given date: number of customers in each cohort and how many of them placed at least two orders with status paid, shipped or delivered, month formatted YYYY-MM, oldest first',
    input: { since: '2025-01-01' },
    altInput: { since: '2026-01-01' },
    output: [{ cohort: 'string', customers: 'integer', repeatCustomers: 'integer' }],
    isOrdered: true,
    expected: (run, input) =>
      run(
        `SELECT to_char(date_trunc('month', c.created_at), 'YYYY-MM') AS cohort, count(*)::int AS customers,
                count(*) FILTER (WHERE coalesce(oc.n, 0) >= 2)::int AS "repeatCustomers"
         FROM customers c
         LEFT JOIN (SELECT customer_id, count(*) AS n FROM orders WHERE status IN ${SOLD} GROUP BY customer_id) oc ON oc.customer_id = c.id
         WHERE c.created_at >= $1::timestamptz
         GROUP BY 1 ORDER BY 1`,
        [input.since],
      ),
  },
  {
    // customers.phone and street_address have no SELECT grant, so they never reach the model.
    // The refusal is reliable; its code is not: core turns a model refusal whose reason
    // reads like a write into WRITE_REFUSED (WRITE_LIKE_REASON in
    // core/src/engine/generation/generate.ts), and a reason that lists the readable
    // columns ("creation date") matches `creat`. This wording makes that rarer.
    kind: 'refusal',
    name: 'customer_pii_refused',
    intent: "read the phone numbers and street addresses of customers who live in a given country, with each customer's email",
    input: { country: 'DE' },
    output: [{ email: 'string', phone: 'string', streetAddress: 'string' }],
    expectedCodes: ['ACCESS_DENIED', 'INTENT_UNSATISFIABLE'],
  },
];
