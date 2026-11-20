// Imported first by every test file, before anything reads config. Real
// environment variables win over sandbox/.env, so these pin tests to a known
// setup regardless of a developer's local .env.
process.env.SLIME_PROVIDER = 'offline';
process.env.SLIME_MODE = 'explore';
process.env.SLIME_REVIEW = 'on';
process.env.SLIME_MODEL = 'offline';
process.env.STATEMENT_TIMEOUT_MS = '500';
process.env.SHAPE_TIMEOUT_MS = '200';
process.env.DATABASE_URL ??= 'postgres://slime_reader:slime_reader@localhost:54329/slime';
process.env.META_DATABASE_URL ??= 'postgres://slime_writer:slime_writer@localhost:54329/slime';
