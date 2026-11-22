-- Slime demo database: a made-up EU online store (12 tables).
-- Run as the database owner while connected to database `shop`
-- (locally: docker-entrypoint-initdb.d; cloud: examples/shop/scripts/load-rds.sh).
-- Data is deterministic (fixed random seed, reference date 2026-11-20 00:00 UTC)
-- so the bench's expected answers and the README's numbers never change.
-- Creates the read-only role shop_reader WITHOUT a password; the loader sets one.
--
-- Random draws are made in a subquery's select list (one column per draw) and
-- used by name outside it: Postgres never inlines a subquery whose select list
-- calls random(), so every row gets its own draws and each draw is used once.
-- ORDER BY inside the draw subqueries fixes the order of random() calls.

SET max_parallel_workers_per_gather = 0;  -- keeps random() call order, and so the data, identical between runs
SET TIME ZONE 'UTC';
SELECT setseed(0.17);

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------
CREATE TABLE categories (
  id        serial  PRIMARY KEY,
  name      text    NOT NULL UNIQUE,
  parent_id integer REFERENCES categories(id)
);

CREATE TABLE products (
  id          serial      PRIMARY KEY,
  sku         text        NOT NULL UNIQUE,
  name        text        NOT NULL,
  category_id integer     NOT NULL REFERENCES categories(id),
  brand       text        NOT NULL,
  price_cents integer     NOT NULL CHECK (price_cents > 0),
  cost_cents  integer     NOT NULL CHECK (cost_cents > 0),
  is_active   boolean     NOT NULL,
  created_at  timestamptz NOT NULL
);

CREATE TABLE warehouses (
  id      serial PRIMARY KEY,
  code    text   NOT NULL UNIQUE,
  city    text   NOT NULL,
  country text   NOT NULL
);

CREATE TABLE inventory (
  warehouse_id integer     NOT NULL REFERENCES warehouses(id),
  product_id   integer     NOT NULL REFERENCES products(id),
  quantity     integer     NOT NULL CHECK (quantity >= 0),
  updated_at   timestamptz NOT NULL,
  PRIMARY KEY (warehouse_id, product_id)
);

CREATE TABLE customers (
  id               serial      PRIMARY KEY,
  first_name       text        NOT NULL,
  last_name        text        NOT NULL,
  email            text        NOT NULL UNIQUE,
  country          text        NOT NULL,
  city             text        NOT NULL,
  created_at       timestamptz NOT NULL,
  marketing_opt_in boolean     NOT NULL,
  -- Personal data: shop_reader is NOT granted these three columns.
  phone            text        NOT NULL,
  street_address   text        NOT NULL,
  postal_code      text        NOT NULL
);

CREATE TABLE discount_codes (
  id          serial      PRIMARY KEY,
  code        text        NOT NULL UNIQUE,
  percent_off integer     NOT NULL CHECK (percent_off BETWEEN 5 AND 50),
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL
);

CREATE TABLE orders (
  id               serial      PRIMARY KEY,
  customer_id      integer     NOT NULL REFERENCES customers(id),
  status           text        NOT NULL CHECK (status IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled')),
  channel          text        NOT NULL CHECK (channel IN ('web', 'mobile_app', 'marketplace')),
  placed_at        timestamptz NOT NULL,
  shipped_at       timestamptz,
  delivered_at     timestamptz,
  shipping_country text        NOT NULL,
  discount_code_id integer     REFERENCES discount_codes(id),
  subtotal_cents   integer     NOT NULL,
  discount_cents   integer     NOT NULL,
  shipping_cents   integer     NOT NULL,
  total_cents      integer     NOT NULL
);

CREATE TABLE order_items (
  id               serial  PRIMARY KEY,
  order_id         integer NOT NULL REFERENCES orders(id),
  product_id       integer NOT NULL REFERENCES products(id),
  quantity         integer NOT NULL CHECK (quantity > 0),
  unit_price_cents integer NOT NULL
);

CREATE TABLE payments (
  id           serial      PRIMARY KEY,
  order_id     integer     NOT NULL REFERENCES orders(id),
  method       text        NOT NULL CHECK (method IN ('card', 'paypal', 'klarna', 'apple_pay')),
  status       text        NOT NULL CHECK (status IN ('captured', 'failed', 'refunded')),
  amount_cents integer     NOT NULL,
  created_at   timestamptz NOT NULL
);

CREATE TABLE returns (
  id            serial      PRIMARY KEY,
  order_item_id integer     NOT NULL UNIQUE REFERENCES order_items(id),
  quantity      integer     NOT NULL CHECK (quantity > 0),
  reason        text        NOT NULL CHECK (reason IN ('damaged', 'wrong_size', 'not_as_described', 'changed_mind', 'late_delivery')),
  status        text        NOT NULL CHECK (status IN ('requested', 'approved', 'rejected', 'refunded')),
  requested_at  timestamptz NOT NULL,
  refund_cents  integer     NOT NULL
);

CREATE TABLE reviews (
  id          serial      PRIMARY KEY,
  product_id  integer     NOT NULL REFERENCES products(id),
  customer_id integer     NOT NULL REFERENCES customers(id),
  rating      smallint    NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title       text        NOT NULL,
  created_at  timestamptz NOT NULL
);

CREATE TABLE carts (
  id          serial      PRIMARY KEY,
  customer_id integer     NOT NULL REFERENCES customers(id),
  status      text        NOT NULL CHECK (status IN ('active', 'abandoned', 'converted')),
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);

CREATE TABLE cart_items (
  cart_id          integer NOT NULL REFERENCES carts(id),
  product_id       integer NOT NULL REFERENCES products(id),
  quantity         integer NOT NULL CHECK (quantity > 0),
  unit_price_cents integer NOT NULL,
  PRIMARY KEY (cart_id, product_id)
);

-- Slime puts these comments into the model's prompt.
COMMENT ON TABLE categories IS 'Two-level catalog tree. Top-level categories have parent_id NULL; every product points at a subcategory.';
COMMENT ON COLUMN products.price_cents IS 'Current list price per unit in cents (EUR).';
COMMENT ON COLUMN products.cost_cents IS 'Purchase cost per unit in cents (EUR).';
COMMENT ON TABLE inventory IS 'Units on hand per product and warehouse.';
COMMENT ON COLUMN customers.marketing_opt_in IS 'True when the customer agreed to marketing emails (GDPR consent).';
COMMENT ON COLUMN discount_codes.ends_at IS 'Exclusive end of the validity window.';
COMMENT ON TABLE orders IS 'One customer order. Revenue counts orders with status paid, shipped or delivered; pending orders are not paid yet and cancelled orders never count.';
COMMENT ON COLUMN orders.status IS 'pending (not paid yet), paid, shipped, delivered or cancelled.';
COMMENT ON COLUMN orders.total_cents IS 'subtotal_cents - discount_cents + shipping_cents, in cents (EUR).';
COMMENT ON COLUMN orders.discount_cents IS 'Order-level discount from discount_code_id, in cents (EUR).';
COMMENT ON COLUMN order_items.unit_price_cents IS 'Price per unit at purchase time in cents (EUR), before the order-level discount.';
COMMENT ON TABLE payments IS 'Payment attempts. An order can have a failed attempt before the captured one; pending orders have none.';
COMMENT ON TABLE returns IS 'At most one return per order item; quantity is the number of units sent back.';
COMMENT ON COLUMN returns.refund_cents IS 'Amount refunded in cents (EUR); 0 unless status is refunded or approved.';
COMMENT ON COLUMN reviews.rating IS '1 (worst) to 5 (best).';
COMMENT ON TABLE carts IS 'Shopping carts. abandoned = left without checkout, converted = checked out, active = still open.';
COMMENT ON COLUMN cart_items.unit_price_cents IS 'Price per unit when added to the cart, in cents (EUR).';

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------
INSERT INTO categories (name, parent_id) VALUES
  ('Electronics', NULL), ('Home & Kitchen', NULL), ('Fashion', NULL),
  ('Sports & Outdoors', NULL), ('Beauty', NULL), ('Books & Toys', NULL),
  ('Headphones', 1), ('Smartphones', 1), ('Laptops', 1), ('Smart Home', 1),
  ('Cookware', 2), ('Coffee & Tea', 2), ('Bedding', 2), ('Lighting', 2),
  ('Sneakers', 3), ('Jackets', 3), ('T-Shirts', 3), ('Bags', 3),
  ('Running', 4), ('Cycling', 4), ('Camping', 4), ('Yoga', 4),
  ('Skincare', 5), ('Haircare', 5), ('Fragrance', 5), ('Makeup', 5),
  ('Fiction', 6), ('Kids Books', 6), ('Board Games', 6), ('Building Sets', 6);

-- 15 products per subcategory; ids (and so SKUs and name numbers) follow subcategory order.
INSERT INTO products (sku, name, category_id, brand, price_cents, cost_cents, is_active, created_at)
SELECT
  'SKU-' || lpad(x.rn::text, 5, '0'),
  x.brand || ' ' || x.adjective || ' ' || x.subcategory || ' ' || (100 + x.rn),
  x.category_id,
  x.brand,
  x.price_cents,
  round(x.price_cents * (0.45 + x.r_cost * 0.25))::int,
  x.r_active < 0.95,
  timestamptz '2024-01-01 00:00+00' + x.r_created * interval '365 days'
FROM (
  SELECT
    s.rn, s.category_id, s.subcategory,
    (ARRAY['Nordwind','Alpenglow','Urbanfox','Kestrel','Lumen','Vela','Brightwood','Fjordline','Copperleaf','Solace','Tidal','Oakridge'])[1 + floor(random() * 12)::int] AS brand,
    (ARRAY['Classic','Pro','Lite','Max','Eco','Air','Prime','Studio','Trail','Mini'])[1 + floor(random() * 10)::int] AS adjective,
    (floor((s.lo + random() * (s.hi - s.lo)) / 100) * 100 + 99)::int AS price_cents,
    random() AS r_cost, random() AS r_active, random() AS r_created
  FROM (
    SELECT row_number() OVER (ORDER BY c.id, n) AS rn, c.id AS category_id, c.name AS subcategory, pr.lo, pr.hi
    FROM categories c
    JOIN (VALUES (1, 2900, 149900), (2, 1500, 29900), (3, 1900, 24900),
                 (4, 1500, 39900), (5, 900, 8900), (6, 900, 14900)) AS pr (top_id, lo, hi) ON pr.top_id = c.parent_id
    CROSS JOIN generate_series(1, 15) AS n
  ) s
  ORDER BY s.rn
) x
ORDER BY x.rn;

-- Popularity and quality per product, used by every later product pick:
-- JOIN product_rank ON rank = 1 + floor(power(r, 2.0) * 360) favours low ranks.
CREATE TEMP TABLE product_rank AS
SELECT x.rank, x.product_id, random() < 0.06 AS low_stock, random() * 2 - 1 AS quality
FROM (SELECT row_number() OVER (ORDER BY random()) AS rank, id AS product_id FROM products) x
ORDER BY x.rank;
ANALYZE product_rank;

INSERT INTO warehouses (code, city, country) VALUES
  ('BER', 'Berlin', 'DE'), ('WAW', 'Warsaw', 'PL'), ('MAD', 'Madrid', 'ES');

INSERT INTO inventory (warehouse_id, product_id, quantity, updated_at)
SELECT
  x.warehouse_id, x.product_id,
  (CASE WHEN x.low_stock THEN floor(x.r_qty * 7) ELSE 10 + floor(x.r_qty * 391) END)::int,
  timestamptz '2026-11-20 00:00+00' - x.r_updated * interval '30 days'
FROM (
  SELECT w.id AS warehouse_id, pr.product_id, pr.low_stock, random() AS r_qty, random() AS r_updated
  FROM warehouses w CROSS JOIN product_rank pr
  ORDER BY w.id, pr.product_id
) x
ORDER BY x.warehouse_id, x.product_id;

-- ---------------------------------------------------------------------------
-- Customers: ids grow with signup time (2024-06-01 .. ~2026-11-15).
-- ---------------------------------------------------------------------------
INSERT INTO customers (first_name, last_name, email, country, city, created_at, marketing_opt_in, phone, street_address, postal_code)
SELECT
  y.first_name, y.last_name,
  lower(y.first_name) || '.' || lower(y.last_name) || '.' || y.g || '@example.com',
  y.country,
  (CASE y.country
     WHEN 'DE' THEN ARRAY['Berlin','Munich']     WHEN 'FR' THEN ARRAY['Paris','Lyon']
     WHEN 'NL' THEN ARRAY['Amsterdam','Rotterdam'] WHEN 'PL' THEN ARRAY['Warsaw','Krakow']
     WHEN 'ES' THEN ARRAY['Madrid','Barcelona']  WHEN 'IT' THEN ARRAY['Milan','Rome']
     WHEN 'AT' THEN ARRAY['Vienna','Graz']       ELSE ARRAY['Stockholm','Gothenburg'] END)[y.city_pick],
  timestamptz '2024-06-01 00:00+00' + ((y.g - 1 + y.r_signup) / 5000.0) * interval '897 days',
  y.r_opt_in < 0.6,
  '+' || (CASE y.country WHEN 'DE' THEN '49' WHEN 'FR' THEN '33' WHEN 'NL' THEN '31' WHEN 'PL' THEN '48'
                         WHEN 'ES' THEN '34' WHEN 'IT' THEN '39' WHEN 'AT' THEN '43' ELSE '46' END)
      || ' ' || lpad(floor(y.r_phone * 1e9)::bigint::text, 9, '0'),
  (1 + floor(y.r_house * 120)::int) || ' '
      || (ARRAY['Linden','Harbour','Market','Station','Garden','Mill','Church','Park'])[1 + floor(y.r_street * 8)::int] || ' Street',
  lpad(floor(y.r_postal * 100000)::int::text, 5, '0')
FROM (
  SELECT x.*,
    CASE WHEN x.r_country < 0.30 THEN 'DE' WHEN x.r_country < 0.45 THEN 'FR' WHEN x.r_country < 0.55 THEN 'NL'
         WHEN x.r_country < 0.65 THEN 'PL' WHEN x.r_country < 0.75 THEN 'ES' WHEN x.r_country < 0.85 THEN 'IT'
         WHEN x.r_country < 0.93 THEN 'AT' ELSE 'SE' END AS country
  FROM (
    SELECT g,
      (ARRAY['Anna','Lukas','Sophie','Mateo','Emma','Jonas','Camille','Luca','Julia','Felix',
             'Zofia','Noah','Clara','Elias','Giulia','Hugo','Laura','Finn','Ingrid','Pablo'])[1 + floor(random() * 20)::int] AS first_name,
      (ARRAY['Schmidt','Dubois','Kowalski','Rossi','Garcia','Jansen','Nilsson','Weber','Martin','Novak',
             'Bianchi','Fernandez','Bakker','Lindqvist','Fischer','Laurent','Wojcik','Romano','Lopez','Hofmann'])[1 + floor(random() * 20)::int] AS last_name,
      random() AS r_country, 1 + floor(random() * 2)::int AS city_pick, random() AS r_signup, random() AS r_opt_in,
      random() AS r_phone, random() AS r_house, random() AS r_street, random() AS r_postal
    FROM generate_series(1, 5000) AS g
    ORDER BY g
  ) x
) y
ORDER BY y.g;

-- Campaign codes (all but WELCOME10) never overlap; ends_at is exclusive.
INSERT INTO discount_codes (code, percent_off, starts_at, ends_at) VALUES
  ('WELCOME10',     10, '2025-01-01 00:00+00', '2027-01-01 00:00+00'),
  ('SPRING15',      15, '2025-03-01 00:00+00', '2025-05-01 00:00+00'),
  ('SUMMER20',      20, '2025-06-15 00:00+00', '2025-09-01 00:00+00'),
  ('BLACKFRIDAY25', 25, '2025-11-24 00:00+00', '2025-12-02 00:00+00'),
  ('XMAS15',        15, '2025-12-02 00:00+00', '2025-12-24 00:00+00'),
  ('SPRING26',      15, '2026-03-01 00:00+00', '2026-05-01 00:00+00'),
  ('SUMMER26',      20, '2026-06-15 00:00+00', '2026-09-01 00:00+00'),
  ('BLACKFRIDAY26', 30, '2026-11-16 00:00+00', '2026-12-01 00:00+00');

-- ---------------------------------------------------------------------------
-- Orders: 2025-01-01 .. 2026-11-19, ~+60 % growth over the period, seasonal peaks.
-- Money columns are filled from the items below.
-- ---------------------------------------------------------------------------
WITH days AS (
  SELECT day, (day::date - date '2025-01-01') AS i, random() AS r_noise
  FROM generate_series(timestamptz '2025-01-01 00:00+00', timestamptz '2026-11-19 00:00+00', interval '1 day') AS day
  ORDER BY day
),
day_counts AS (
  SELECT day, round(45 * (1 + 0.6 * i / 687.0) * season * (0.85 + r_noise * 0.3))::int AS n
  FROM (
    SELECT day, i, r_noise,
      CASE
        WHEN day::date = date '2025-11-28' THEN 4.0
        WHEN day::date BETWEEN date '2025-11-24' AND date '2025-12-01' THEN 2.0
        WHEN extract(month FROM day) = 12 AND extract(day FROM day) BETWEEN 2 AND 23 THEN 1.8
        WHEN extract(month FROM day) = 12 AND extract(day FROM day) >= 24 THEN 0.9
        WHEN day::date BETWEEN date '2026-11-16' AND date '2026-11-19' THEN 1.5
        WHEN extract(month FROM day) = 11 THEN 1.3
        WHEN extract(month FROM day) = 1 THEN 0.8
        WHEN extract(month FROM day) IN (7, 8) THEN 0.9
        ELSE 1.0
      END AS season
    FROM days
  ) s
),
draws AS (
  SELECT dc.day, k,
    dc.day + random() * interval '1 day' AS placed_at,
    random() AS r_customer, random() AS r_channel, random() AS r_ship, random() AS r_deliver,
    random() AS r_status, random() AS r_campaign, random() AS r_welcome
  FROM day_counts dc CROSS JOIN LATERAL generate_series(1, dc.n) AS k
  ORDER BY dc.day, k
),
timed AS (
  SELECT d.*,
    d.placed_at + (1 + d.r_ship * 2) * interval '1 day' AS ship_at,
    d.placed_at + (1 + d.r_ship * 2) * interval '1 day' + (1 + d.r_deliver * 4) * interval '1 day' AS deliver_at,
    -- Highest customer id already signed up at placed_at (see customers.created_at).
    greatest(1, least(5000, floor(5000 * extract(epoch FROM d.placed_at - timestamptz '2024-06-01 00:00+00') / (897 * 86400)))) AS max_id
  FROM draws d
),
shaped AS (
  SELECT t.*,
    1 + floor(power(t.r_customer, 0.8) * t.max_id)::int AS customer_id,
    CASE
      WHEN t.r_status < 0.04 THEN 'cancelled'
      WHEN t.deliver_at < timestamptz '2026-11-20 00:00+00' THEN 'delivered'
      WHEN t.ship_at < timestamptz '2026-11-20 00:00+00' THEN 'shipped'
      WHEN t.placed_at < timestamptz '2026-11-20 00:00+00' - interval '2 hours' THEN 'paid'
      ELSE 'pending'
    END AS status
  FROM timed t
)
INSERT INTO orders (customer_id, status, channel, placed_at, shipped_at, delivered_at, shipping_country,
                    discount_code_id, subtotal_cents, discount_cents, shipping_cents, total_cents)
SELECT
  s.customer_id,
  s.status,
  CASE WHEN s.r_channel < 0.55 THEN 'web' WHEN s.r_channel < 0.90 THEN 'mobile_app' ELSE 'marketplace' END,
  s.placed_at,
  CASE WHEN s.status IN ('shipped', 'delivered') THEN s.ship_at END,
  CASE WHEN s.status = 'delivered' THEN s.deliver_at END,
  c.country,
  CASE
    WHEN camp.id IS NOT NULL AND s.r_campaign < 0.35 THEN camp.id
    WHEN s.r_welcome < 0.05 THEN (SELECT id FROM discount_codes WHERE code = 'WELCOME10')
  END,
  0, 0, 0, 0
FROM shaped s
JOIN customers c ON c.id = s.customer_id
LEFT JOIN discount_codes camp
  ON camp.code <> 'WELCOME10' AND s.placed_at >= camp.starts_at AND s.placed_at < camp.ends_at
ORDER BY s.placed_at, s.day, s.k;

-- 1-4 items per order (mean ~1.9), popular products more often; duplicates allowed.
INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
SELECT
  x.order_id, pr.product_id,
  CASE WHEN x.r_qty < 0.80 THEN 1 WHEN x.r_qty < 0.95 THEN 2 ELSE 3 END,
  p.price_cents
FROM (
  SELECT o.id AS order_id, k, random() AS r_product, random() AS r_qty
  FROM (SELECT id, 1 + floor(power(random(), 2.0) * 4)::int AS n_items FROM orders ORDER BY id) o
  CROSS JOIN LATERAL generate_series(1, o.n_items) AS k
  ORDER BY o.id, k
) x
JOIN product_rank pr ON pr.rank = 1 + floor(power(x.r_product, 2.0) * 360)::int
JOIN products p ON p.id = pr.product_id
ORDER BY x.order_id, x.k;

WITH sums AS (
  SELECT o.id, sum(oi.quantity * oi.unit_price_cents)::int AS subtotal,
         round(sum(oi.quantity * oi.unit_price_cents) * coalesce(d.percent_off, 0) / 100.0)::int AS discount
  FROM orders o
  JOIN order_items oi ON oi.order_id = o.id
  LEFT JOIN discount_codes d ON d.id = o.discount_code_id
  GROUP BY o.id, d.percent_off
)
UPDATE orders o SET
  subtotal_cents = s.subtotal,
  discount_cents = s.discount,
  shipping_cents = CASE WHEN s.subtotal - s.discount >= 5000 THEN 0 ELSE 499 END,
  total_cents    = s.subtotal - s.discount + CASE WHEN s.subtotal - s.discount >= 5000 THEN 0 ELSE 499 END
FROM sums s
WHERE s.id = o.id;

-- One payment per non-pending order; 3 % of sold orders also have an earlier failed attempt.
WITH d AS (
  SELECT id, status, placed_at, total_cents,
    random() AS r_method, random() AS r_status, random() AS r_extra, random() AS r_extra_method
  FROM orders WHERE status <> 'pending'
  ORDER BY id
)
INSERT INTO payments (order_id, method, status, amount_cents, created_at)
SELECT order_id, method, status, amount_cents, created_at
FROM (
  SELECT id AS order_id,
    CASE WHEN r_method < 0.50 THEN 'card' WHEN r_method < 0.75 THEN 'paypal' WHEN r_method < 0.90 THEN 'klarna' ELSE 'apple_pay' END AS method,
    CASE WHEN status <> 'cancelled' THEN 'captured' WHEN r_status < 0.6 THEN 'failed' ELSE 'refunded' END AS status,
    total_cents AS amount_cents,
    placed_at + interval '2 minutes' AS created_at
  FROM d
  UNION ALL
  SELECT id,
    CASE WHEN r_extra_method < 0.50 THEN 'card' WHEN r_extra_method < 0.75 THEN 'paypal' WHEN r_extra_method < 0.90 THEN 'klarna' ELSE 'apple_pay' END,
    'failed',
    total_cents,
    placed_at + interval '1 minute'
  FROM d
  WHERE status <> 'cancelled' AND r_extra < 0.03
) p
ORDER BY created_at, order_id;

-- Returns of delivered items; Fashion comes back most (mostly wrong_size), Beauty least.
INSERT INTO returns (order_item_id, quantity, reason, status, requested_at, refund_cents)
SELECT
  y.order_item_id, y.quantity, y.reason, y.status, y.requested_at,
  CASE WHEN y.status IN ('refunded', 'approved') THEN y.quantity * y.unit_price_cents ELSE 0 END
FROM (
  SELECT x.order_item_id, x.quantity, x.unit_price_cents, x.requested_at,
    CASE
      WHEN x.top_category = 'Fashion' THEN
        CASE WHEN x.r_reason < 0.6 THEN 'wrong_size'
             ELSE (ARRAY['damaged','not_as_described','changed_mind','late_delivery'])[1 + floor(x.r_reason_other * 4)::int] END
      WHEN x.r_reason < 0.30 THEN 'damaged'
      WHEN x.r_reason < 0.55 THEN 'not_as_described'
      WHEN x.r_reason < 0.85 THEN 'changed_mind'
      ELSE 'late_delivery'
    END AS reason,
    CASE
      WHEN x.requested_at > timestamptz '2026-11-20 00:00+00' - interval '3 days' THEN 'requested'
      WHEN x.r_status < 0.85 THEN 'refunded'
      WHEN x.r_status < 0.95 THEN 'rejected'
      ELSE 'approved'
    END AS status
  FROM (
    SELECT w.*, w.delivered_at + (1 + w.r_requested * 20) * interval '1 day' AS requested_at
    FROM (
      SELECT oi.id AS order_item_id, oi.quantity, oi.unit_price_cents, top.name AS top_category, o.delivered_at,
        random() AS r_return, random() AS r_requested, random() AS r_reason, random() AS r_reason_other, random() AS r_status
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id AND o.status = 'delivered'
      JOIN products p ON p.id = oi.product_id
      JOIN categories sub ON sub.id = p.category_id
      JOIN categories top ON top.id = sub.parent_id
      ORDER BY oi.id
    ) w
    WHERE w.r_return < CASE w.top_category
                         WHEN 'Fashion' THEN 0.15 WHEN 'Electronics' THEN 0.06 WHEN 'Sports & Outdoors' THEN 0.05
                         WHEN 'Home & Kitchen' THEN 0.04 WHEN 'Books & Toys' THEN 0.025 ELSE 0.02 END
  ) x
  WHERE x.requested_at < timestamptz '2026-11-20 00:00+00'
) y
ORDER BY y.requested_at, y.order_item_id;

-- Reviews of delivered items; ratings follow each product's hidden quality.
INSERT INTO reviews (product_id, customer_id, rating, title, created_at)
SELECT y.product_id, y.customer_id, y.rating,
  (ARRAY['Broke after a week','Disappointing','It is okay','Very good','Love it'])[y.rating],
  y.created_at
FROM (
  SELECT x.product_id, x.customer_id, x.order_item_id,
    greatest(1, least(5, round(3.6 + 1.4 * x.quality + (x.r_rating - 0.5) * 2)))::smallint AS rating,
    x.delivered_at + (2 + x.r_created * 14) * interval '1 day' AS created_at
  FROM (
    SELECT oi.id AS order_item_id, oi.product_id, o.customer_id, o.delivered_at, pr.quality,
      random() AS r_review, random() AS r_rating, random() AS r_created
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id AND o.status = 'delivered'
    JOIN product_rank pr ON pr.product_id = oi.product_id
    ORDER BY oi.id
  ) x
  WHERE x.r_review < 0.25
) y
WHERE y.created_at < timestamptz '2026-11-20 00:00+00'
ORDER BY y.created_at, y.order_item_id;

-- ---------------------------------------------------------------------------
-- Carts
-- ---------------------------------------------------------------------------
INSERT INTO carts (customer_id, status, created_at, updated_at)
SELECT
  1 + floor(power(x.r_customer, 0.8)
            * greatest(1, least(5000, floor(5000 * extract(epoch FROM x.created_at - timestamptz '2024-06-01 00:00+00') / (897 * 86400)))))::int,
  CASE WHEN x.created_at > timestamptz '2026-11-20 00:00+00' - interval '1 day' THEN 'active'
       WHEN x.r_status < 0.35 THEN 'converted'
       ELSE 'abandoned' END,
  x.created_at,
  least(x.created_at + x.r_updated * interval '2 hours', timestamptz '2026-11-20 00:00+00')
FROM (
  SELECT g,
    timestamptz '2025-01-01 00:00+00' + random() * (timestamptz '2026-11-20 00:00+00' - timestamptz '2025-01-01 00:00+00') AS created_at,
    random() AS r_customer, random() AS r_status, random() AS r_updated
  FROM generate_series(1, 30000) AS g
  ORDER BY g
) x
ORDER BY x.created_at, x.g;

INSERT INTO cart_items (cart_id, product_id, quantity, unit_price_cents)
SELECT x.cart_id, pr.product_id, CASE WHEN x.r_qty < 0.8 THEN 1 ELSE 2 END, p.price_cents
FROM (
  SELECT c.id AS cart_id, k, random() AS r_product, random() AS r_qty
  FROM (SELECT id, 1 + floor(power(random(), 1.5) * 4)::int AS n_lines FROM carts ORDER BY id) c
  CROSS JOIN LATERAL generate_series(1, c.n_lines) AS k
  ORDER BY c.id, k
) x
JOIN product_rank pr ON pr.rank = 1 + floor(power(x.r_product, 2.0) * 360)::int
JOIN products p ON p.id = pr.product_id
ORDER BY x.cart_id, x.k
ON CONFLICT (cart_id, product_id) DO NOTHING;

CREATE INDEX ON orders (customer_id);
CREATE INDEX ON orders (placed_at);
CREATE INDEX ON order_items (order_id);
CREATE INDEX ON order_items (product_id);
CREATE INDEX ON payments (order_id);
CREATE INDEX ON reviews (product_id);
CREATE INDEX ON carts (customer_id);
CREATE INDEX ON carts (updated_at);
CREATE INDEX ON inventory (product_id);
CREATE INDEX ON products (category_id);

DROP TABLE product_rank;
ANALYZE;

-- ---------------------------------------------------------------------------
-- The read-only user Slime connects as. This is the real safety boundary:
-- generated SQL can only do what this role is allowed to do.
-- ---------------------------------------------------------------------------
CREATE ROLE shop_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE shop FROM PUBLIC;           -- other roles on the instance (slime_reader) can't even connect
GRANT CONNECT ON DATABASE shop TO shop_reader;
GRANT USAGE ON SCHEMA public TO shop_reader;

GRANT SELECT ON categories, products, warehouses, inventory, discount_codes, orders, order_items,
  payments, returns, reviews, carts, cart_items TO shop_reader;
-- Column-level grant: every customers column except phone, street_address and postal_code.
GRANT SELECT (id, first_name, last_name, email, country, city, created_at, marketing_opt_in) ON customers TO shop_reader;

-- Defence in depth only: Slime also opens every query in a READ ONLY transaction with its own timeout.
ALTER ROLE shop_reader SET default_transaction_read_only = on;
ALTER ROLE shop_reader SET statement_timeout = '2s';
ALTER ROLE shop_reader SET idle_in_transaction_session_timeout = '5s';
ALTER ROLE shop_reader SET timezone = 'UTC';  -- month/day bucketing by generated SQL never depends on the server's zone
