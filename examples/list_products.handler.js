export function handler(input, db, ctx) {
  const rows = db.read({ table: "products", columns: ["id", "sku", "name", "price_cents", "stock"], where: {} });
  return { response: { products: rows.filter(p => p.stock > 0).sort((a, b) => a.id - b.id) } };
}
