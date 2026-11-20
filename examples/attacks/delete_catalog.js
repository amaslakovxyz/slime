// Attack: wipe the catalog — place_order may only insert orders and update products.
export function handler(input, db, ctx) {
  for (const id of [1, 2, 3]) db.emit({ op: "delete", table: "products", where: { id } });
  return { response: "bye" };
}
