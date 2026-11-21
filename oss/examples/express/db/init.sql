-- Slime demo database: a made-up SaaS billing domain.
-- Runs once, as the superuser, when the container is first created.
-- Data is deterministic (fixed random seed, fixed reference date) so the
-- benchmark's expected answers never change.

CREATE TABLE plans (
  id                  serial PRIMARY KEY,
  name                text    NOT NULL UNIQUE,
  monthly_price_cents integer NOT NULL
);

CREATE TABLE accounts (
  id            serial PRIMARY KEY,
  name          text        NOT NULL,
  email         text        NOT NULL,
  country       text        NOT NULL,
  plan_id       integer     NOT NULL REFERENCES plans(id),
  created_at    timestamptz NOT NULL,
  -- Sensitive column: slime_reader is NOT granted access to it.
  password_hash text        NOT NULL
);

CREATE TABLE subscriptions (
  id          serial PRIMARY KEY,
  account_id  integer     NOT NULL REFERENCES accounts(id),
  plan_id     integer     NOT NULL REFERENCES plans(id),
  status      text        NOT NULL CHECK (status IN ('active', 'past_due', 'canceled')),
  started_at  timestamptz NOT NULL,
  canceled_at timestamptz
);

CREATE TABLE invoices (
  id           serial PRIMARY KEY,
  account_id   integer     NOT NULL REFERENCES accounts(id),
  amount_cents integer     NOT NULL,
  status       text        NOT NULL CHECK (status IN ('paid', 'open', 'failed')),
  issued_at    timestamptz NOT NULL
);

CREATE TABLE usage_events (
  id          bigserial PRIMARY KEY,
  account_id  integer     NOT NULL REFERENCES accounts(id),
  event_type  text        NOT NULL CHECK (event_type IN ('login', 'api_call', 'export')),
  occurred_at timestamptz NOT NULL
);

COMMENT ON TABLE usage_events IS 'Product activity per account. Few recent events suggests churn risk.';
COMMENT ON COLUMN invoices.amount_cents IS 'Invoice total in cents (EUR).';
COMMENT ON COLUMN subscriptions.status IS 'active, past_due or canceled.';

SELECT setseed(0.42);

INSERT INTO plans (name, monthly_price_cents) VALUES
  ('Free', 0), ('Starter', 2900), ('Growth', 9900), ('Enterprise', 49900);

INSERT INTO accounts (name, email, country, plan_id, created_at, password_hash)
SELECT
  (ARRAY['Blue','Swift','Iron','Lunar','Crimson','Quiet','Bright','Nova','Silver','Atlas'])[1 + floor(random() * 10)::int]
    || ' ' ||
  (ARRAY['Labs','Systems','Works','Analytics','Logistics','Studio','Health','Retail','Cloud','Foods'])[1 + floor(random() * 10)::int]
    || ' ' || g,
  'billing+' || g || '@example.com',
  (ARRAY['DE','FR','NL','PL','ES','IT','SE','US'])[1 + floor(random() * 8)::int],
  1 + floor(random() * 4)::int,
  timestamptz '2025-01-01' + (random() * 500) * interval '1 day',
  md5('secret-' || g)
FROM generate_series(1, 200) AS g;

INSERT INTO subscriptions (account_id, plan_id, status, started_at, canceled_at)
SELECT
  a.id,
  a.plan_id,
  s.status,
  a.created_at,
  CASE WHEN s.status = 'canceled' THEN timestamptz '2026-11-20' - (random() * 120) * interval '1 day' END
FROM accounts a
CROSS JOIN LATERAL (
  SELECT CASE WHEN r < 0.75 THEN 'active' WHEN r < 0.88 THEN 'past_due' ELSE 'canceled' END AS status
  FROM (SELECT random() + a.id * 0 AS r) x
) s;

-- One invoice per month from account creation up to 2026-11-01, paid plans only.
INSERT INTO invoices (account_id, amount_cents, status, issued_at)
SELECT
  a.id,
  p.monthly_price_cents + (floor(random() * 2000))::int,
  CASE WHEN r < 0.86 THEN 'paid' WHEN r < 0.94 THEN 'open' ELSE 'failed' END,
  m
FROM accounts a
JOIN plans p ON p.id = a.plan_id AND p.monthly_price_cents > 0
CROSS JOIN LATERAL generate_series(date_trunc('month', a.created_at) + interval '1 month',
                                   timestamptz '2026-11-01', interval '1 month') AS m
CROSS JOIN LATERAL (SELECT random() + a.id * 0 + extract(epoch FROM m) * 0 AS r) x;

-- Activity: most accounts are active, about a fifth have gone quiet in the last 60 days.
INSERT INTO usage_events (account_id, event_type, occurred_at)
SELECT
  a.id,
  (ARRAY['login','api_call','api_call','export'])[1 + floor(random() * 4)::int],
  timestamptz '2026-11-20' - (CASE WHEN a.id % 5 = 0 THEN 60 + random() * 200 ELSE random() * 90 END) * interval '1 day'
FROM accounts a
CROSS JOIN LATERAL generate_series(1, 5 + (a.id % 25)) AS n;

ANALYZE;

-- ---------------------------------------------------------------------------
-- The read-only user Slime connects as. This is the real safety boundary:
-- generated SQL can only do what this role is allowed to do.
-- ---------------------------------------------------------------------------
CREATE ROLE slime_reader LOGIN PASSWORD 'slime_reader'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE TEMPORARY ON DATABASE slime FROM PUBLIC;
GRANT CONNECT ON DATABASE slime TO slime_reader;
GRANT USAGE ON SCHEMA public TO slime_reader;

GRANT SELECT ON plans, subscriptions, invoices, usage_events TO slime_reader;
-- Column-level grant: every accounts column except password_hash.
GRANT SELECT (id, name, email, country, plan_id, created_at) ON accounts TO slime_reader;

-- Defence in depth only: generated SQL could try to change session settings,
-- so the app also opens every query in a READ ONLY transaction with its own timeout.
ALTER ROLE slime_reader SET default_transaction_read_only = on;
ALTER ROLE slime_reader SET statement_timeout = '2s';
ALTER ROLE slime_reader SET idle_in_transaction_session_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Slime's own storage (Liquid handlers and their recorded runs). A separate
-- user owns a separate schema: generated SQL runs as slime_reader, which has
-- no access to it, so generated code can never read or change stored handlers.
-- Slime creates its tables itself on startup.
-- ---------------------------------------------------------------------------
CREATE ROLE slime_writer LOGIN PASSWORD 'slime_writer'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT CONNECT ON DATABASE slime TO slime_writer;
CREATE SCHEMA slime_meta AUTHORIZATION slime_writer;
REVOKE ALL ON SCHEMA slime_meta FROM PUBLIC;
