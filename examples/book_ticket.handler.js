export function handler(input, db, ctx) {
  if (!input.qty || input.qty < 1) return { response: null, error: "BAD_QTY" };
  const events = db.read({ table: "events", columns: ["id", "capacity", "price_cents"], where: { id: input.eventId } });
  if (events.length === 0) return { response: null, error: "EVENT_NOT_FOUND" };
  let total = input.qty * events[0].price_cents;
  if (input.promo) {
    const promos = db.read({ table: "promos", columns: ["code", "pct"], where: { code: input.promo } });
    if (promos.length > 0) {
      const pct = Math.min(promos[0].pct, 50);
      total = Math.round(total * (100 - pct) / 100);
    }
  }
  db.emit({ op: "insert", table: "tickets",
            data: { event_id: input.eventId, user_id: ctx.userId, qty: input.qty,
                    promo_code: input.promo ?? null, total_cents: total } });
  return { response: { total_cents: total } };
}
