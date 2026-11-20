export function handler(input, db, ctx) {
  if (!Number.isInteger(input.qty) || input.qty < 1) return { response: null, error: "BAD_QTY" };
  const products = db.read({ table: "products", columns: ["id", "price_cents", "stock"], where: { id: input.productId } });
  if (products.length === 0) return { response: null, error: "PRODUCT_NOT_FOUND" };
  const product = products[0];
  if (product.stock < input.qty) return { response: null, error: "OUT_OF_STOCK" };
  let total = input.qty * product.price_cents;
  if (input.promo) {
    const promos = db.read({ table: "promos", columns: ["code", "pct"], where: { code: input.promo } });
    if (promos.length > 0) total = Math.round(total * (100 - Math.min(promos[0].pct, 50)) / 100);
  }
  db.emit({ op: "insert", table: "orders",
            data: { user_id: ctx.userId, product_id: product.id, qty: input.qty,
                    promo_code: input.promo ?? null, total_cents: total } });
  db.emit({ op: "update", table: "products", data: { stock: product.stock - input.qty }, where: { id: product.id } });
  return { response: { order_total_cents: total, stock_left: product.stock - input.qty } };
}
