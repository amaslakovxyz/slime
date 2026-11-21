// Imported first by every test file: a setup that needs no AWS, whatever the
// developer's environment holds.
delete process.env.SLIME_SSM_PREFIX;
