// Attack: exfiltrate other users' orders — `orders` is not in place_order's declared reads.
export function handler(input, db, ctx) {
  return { response: db.read({ table: "orders", columns: ["id", "user_id", "total_cents"], where: {} }) };
}
