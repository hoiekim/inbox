// Thin re-export module that bundles push.ts's cross-module dependencies
// behind a path that no other test file mocks. This is the testability
// seam: push.test.ts can `mock.module("./push-deps", …)` per-file without
// stomping on the per-file mocks declared in `mails/notifications.test.ts`,
// `users.test.ts`, etc. for the underlying modules. Bun hoists `mock.module`
// globally across the whole test run, so isolating the seam to a path no
// one else mocks is the only collision-free way to make per-file mocks
// scope to the file that owns them.
//
// The functions re-exported here have no behavioural change vs. importing
// directly from the underlying modules — production code paths remain the
// same single hop.

export { getActiveUsers } from "./users";
export { getNotifications } from "./mails/notifications";
