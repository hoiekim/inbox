// Repro for the POST /api/mails/mark badge off-by-one.
//
// Real: postgres pool, getUnreadNotifications, getNotifications, markRead.
// Stubbed: the web-push transport (records the payload) and the subscription
// repo (one fake subscription). Nothing about the COUNT is faked.
import "../src/server/config";
const { createPush } = await import("../src/server/lib/push");
const { getNotifications } = await import("../src/server/lib/mails/notifications");
const { markRead } = await import("../src/server/lib/mails/update");
const { pool } = await import("../src/server/lib/postgres/client");

const USERNAME = process.env.REPRO_USER || "admin";
const u = await pool.query("SELECT user_id, username FROM users WHERE username=$1", [USERNAME]);
const user = { id: u.rows[0].user_id, username: u.rows[0].username };

const unread = async () => {
  const r = await pool.query(
    `SELECT count(*)::int n FROM mails WHERE user_id=$1 AND sent=FALSE
       AND is_spam=FALSE AND expunged=FALSE AND draft=FALSE AND read=FALSE`,
    [user.id]
  );
  return r.rows[0].n as number;
};

const target = await pool.query(
  `SELECT mail_id, updated FROM mails WHERE user_id=$1 AND sent=FALSE
     AND is_spam=FALSE AND expunged=FALSE AND draft=FALSE AND read=FALSE
   ORDER BY date DESC LIMIT 1`,
  [user.id]
);
if (!target.rows.length) { console.log("no unread mail to test with"); process.exit(1); }
const { mail_id, updated } = target.rows[0];

const sentPayloads: { badge_count: number }[] = [];
const fakeWebPush = {
  setVapidDetails: () => {},
  sendNotification: async (_s: unknown, payload: string) => { sentPayloads.push(JSON.parse(payload)); return {}; },
};
const fakeRepo = {
  getSubscriptions: async () => [{
    push_subscription_id: "sub-1", username: USERNAME,
    endpoint: "https://example.invalid/x", keys: { p256dh: "x", auth: "y" },
    lastNotified: new Date(0),
  }],
  deleteSubscription: async () => {}, updateLastNotified: async () => {},
};
const noop = () => {};
const push = createPush(
  fakeWebPush as never, fakeRepo as never, (async () => [user]) as never,
  getNotifications, { notifyNewMail: noop } as never,
  { debug: noop, info: noop, warn: noop, error: noop } as never,
  { PUSH_VAPID_PUBLIC_KEY: "pub", PUSH_VAPID_PRIVATE_KEY: "priv", EMAIL_DOMAIN: "hoie.kim" }
);
push.initPush();

console.log(`unread BEFORE mark-read : ${await unread()}`);

// --- exactly what postMarkMailRoute does, in that order ---
await markRead(user.id, mail_id);
await push.decrementBadgeCount([user as never]);
// ----------------------------------------------------------

const after = await unread();
const badge = sentPayloads[0].badge_count;
console.log(`unread AFTER  mark-read : ${after}   <-- truth the badge should show`);
console.log(`badge_count PUSHED      : ${badge}`);
console.log(badge === after ? "OK — badge matches" : `MISMATCH — badge is ${after - badge} lower than the real unread count`);

await pool.query("UPDATE mails SET read=FALSE, updated=$2 WHERE mail_id=$1", [mail_id, updated]);
console.log(`restored, unread now    : ${await unread()}`);
await pool.end();
