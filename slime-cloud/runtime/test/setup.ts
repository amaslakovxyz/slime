// Imported first by every test file, before anything reads @slime-cloud/core's
// config: pins an offline, AWS-free setup regardless of the developer's env.
process.env.SLIME_PROVIDER = 'offline';
process.env.SLIME_MODEL = 'offline';
process.env.SLIME_MODE = 'explore';
delete process.env.SLIME_SSM_PREFIX;
