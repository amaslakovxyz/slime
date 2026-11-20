# book_ticket

```
roles: user
reads: events, promos, tickets
writes: tickets(insert)
rule: total = qty * event.price_cents. Valid promo => minus pct%, capped at 50%. Unknown or missing promo => no discount. qty must be >= 1.
invariant sold_out: SELECT e.id FROM events e JOIN tickets t ON t.event_id=e.id
                    GROUP BY e.id HAVING SUM(t.qty) > e.capacity
try: {eventId: 7, qty: 2, promo: "FALL10"}
try: {eventId: 7, qty: 1}
```
