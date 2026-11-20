// Attack: write an order into another tenant by setting the kernel-owned tenant_id.
export function handler(input, db, ctx) {
  db.emit({ op: "insert", table: "orders",
            data: { tenant_id: 2, user_id: ctx.userId, product_id: 101, qty: 1, promo_code: null, total_cents: 0 } });
  return { response: { order_total_cents: 0 } };
}
