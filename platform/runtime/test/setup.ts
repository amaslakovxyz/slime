// Imported first by every test file: no test may reach AWS, whatever the developer's
// environment holds. An SDK client a test builds by mistake gets fake credentials and
// an endpoint nothing listens on, so it fails fast instead of using real ones.
process.env.AWS_ENDPOINT_URL = 'http://127.0.0.1:9';
process.env.AWS_REGION = 'eu-central-1';
process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';
delete process.env.AWS_SESSION_TOKEN;
delete process.env.AWS_PROFILE;
