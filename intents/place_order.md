# place_order

```
roles: user
reads: products, promos
writes: orders(insert), products(update)
rule: Buy qty units of product input.productId. qty must be an integer >= 1, else error BAD_QTY. Unknown product => error PRODUCT_NOT_FOUND. If product.stock < qty => error OUT_OF_STOCK. total = qty * product.price_cents; a valid promo (input.promo, looked up in promos by code) => minus pct%, capped at 50%, rounded to whole cents; unknown or missing promo => no discount. Insert one order (user_id = ctx.userId, product_id, qty, promo_code or null, total_cents) and update the product row by id setting stock = stock - qty. Response: { order_total_cents, stock_left }.
invariant no_negative_stock: SELECT id FROM products WHERE tenant_id = :tenant_id AND stock < 0
try: {productId: 1, qty: 2, promo: "FALL10"}
try: {productId: 2, qty: 1}
```
