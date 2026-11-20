export function handler(input, db, ctx) {
  if (!Number.isInteger(input.qty) || input.qty < 1) return { response: null, error: "BAD_QTY" };
  const products = db.read({ table: "products", columns: ["id", "stock"], where: { id: input.productId } });
  if (products.length === 0) return { response: null, error: "PRODUCT_NOT_FOUND" };
  const stock = products[0].stock + input.qty;
  db.emit({ op: "update", table: "products", data: { stock }, where: { id: input.productId } });
  return { response: { stock } };
}
