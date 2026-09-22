/**
 * The largest whole RFC 5322 message the process will hold at once.
 *
 * Every surface that materializes a message shares this ceiling — SMTP DATA on
 * the relay, and the IMAP APPEND literal a client files into Sent or Drafts.
 * Two numbers would let one surface admit what the other refuses while both
 * spend the same heap.
 *
 * The composer's per-file 25 MiB upload cap measures a different quantity: one
 * attachment, before base64 inflates it on the wire by a third. 35 MiB clears
 * the message sizes mainstream providers accept.
 */
export const MAX_MESSAGE_BYTES = 35 * 1024 * 1024;
