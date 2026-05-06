// Bun test preload — runs before any test file is parsed.
//
// push.ts captures vapidConfigured at module-init time. If a different test
// file's transitive imports trigger push.ts to load before push.test.ts has
// even been parsed (which happens in CI, but not always locally), the
// in-file env assignments come too late. Setting them here guarantees they
// are present whenever push.ts is first evaluated within the test run.
//
// Use real generated VAPID keys (not placeholder strings): web-push validates
// the public key decodes to 65 bytes at setVapidDetails(), and a stub like
// "test-public-key" throws on transitive load before push.test.ts can mock
// the library.
import webPush from "web-push";
const { publicKey, privateKey } = webPush.generateVAPIDKeys();
process.env.PUSH_VAPID_PUBLIC_KEY ??= publicKey;
process.env.PUSH_VAPID_PRIVATE_KEY ??= privateKey;
process.env.EMAIL_DOMAIN ??= "test.com";
