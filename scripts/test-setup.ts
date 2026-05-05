// Bun test preload — runs before any test file is parsed.
//
// push.ts captures vapidConfigured at module-init time. If a different test
// file's transitive imports trigger push.ts to load before push.test.ts has
// even been parsed (which happens in CI, but not always locally), the
// in-file env assignments come too late. Setting them here guarantees they
// are present whenever push.ts is first evaluated within the test run.
process.env.PUSH_VAPID_PUBLIC_KEY ??= "test-public-key";
process.env.PUSH_VAPID_PRIVATE_KEY ??= "test-private-key";
process.env.EMAIL_DOMAIN ??= "test.com";
