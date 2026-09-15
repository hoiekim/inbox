# IMAP memory-pressure operations

This document describes the container OOM class triggered by iOS Mail's
pipelined `UID FETCH X (UID BODY)` bursts against large mailboxes, the
defensive mitigations that live in tree, and what still needs to be done to
close the root cause.

## The symptom

The IMAP server container OOM-crashes when a single client pipelines 10+ full
BODY fetches on one socket for a multi-megabyte body. RSS climbs from ~140 MB
baseline past the 256 MiB cgroup limit inside a few seconds. Because the crash
takes the whole container down, every open IMAP session (and the SMTP
listener) dies simultaneously. Any client mid-sync gets a hard cut and the
next reconnect wave arrives before Postgres pool + table setup finish, which
has produced boot loops on prior incidents.

The tracking issue is 757. Related landed work: 727 (global concurrency
limiter), 773 (streamed BODY[]), 843 (session buffer cap), 836 (literal
payloads as octets). None of these alone stops the alarms.

## What this repo ships today (defense in depth)

### 1. Container-level cgroup ceiling — `mem_limit: 384m`

Raised from the historical 256 MiB. Not a fix — a workaround while the real
per-command allocation source is being attributed. This lives in
`docker-compose.yml`.

Caveat: the production cgroup limit may be set outside this compose file
(systemd unit, `docker run --memory`, or a compose override the deploy
pipeline injects). If that is the case, `mem_limit` here is documentation and
the effective ceiling has to be updated on the host too. See
`reference_prod_compose_drift` in the operator's memory bank.

### 2. Per-connection RSS soft-guard

Before a FETCH that would emit a body-bearing section (`BODY[]`,
`BODY[TEXT]`, `BODY[<part>]` bare or `.TEXT`, `RFC822`, `RFC822.TEXT`) starts
streaming, the session snapshots `process.memoryUsage().rss` and compares it
to the soft-limit threshold.

If RSS is at or above the threshold, the session emits

    <tag> NO [SERVERBUG] server memory pressure - retry

and closes the socket through the shared teardown primitive. One hot socket
loses its FETCH; every other session on the container survives, and no other
IMAP or SMTP work is disrupted. The client sees a tagged failure it can
retry, rather than a mid-stream connection reset with no explanation.

Header-like sections (`HEADER`, `HEADER.FIELDS`, `<part>.HEADER`,
`<part>.MIME`) are a few KiB each and are NOT guarded — a `UID FETCH X
BODY[HEADER]` under pressure still completes so that clients doing envelope
sync are not blocked by a hot body-fetch elsewhere.

Configuration:

- `IMAP_RSS_SOFT_LIMIT_MB` — default 200. That is ~78% of the historical 256
  MiB ceiling and ~52% of the new 384 MiB ceiling; either way it leaves
  headroom for one in-flight response to complete.

To raise the threshold on a live droplet: set the env var on the container
and restart. To disable the guard entirely, set it to something above the
cgroup limit (the process cannot allocate past its own ceiling, so an
unreachable threshold is a no-op).

### 3. Optional per-BODY[] instrumentation — `IMAP_MEM_TRACE=1`

Off by default. When set, every stream part in a FETCH response — that is,
every `BODY[...]<{N}>` literal about to be written — emits one INFO-level log
line to journald:

    RSS_DELTA cmd=<section-key> uid=<N> mailbox=<name> \
      heapUsed=<K>K-><K>K external=<K>K-><K>K rss=<K>K-><K>K bytes_out=<N>

The `before -> after` deltas are what the issue-757 candidate-hypotheses
table needs to distinguish "V8 GC lag" (RSS climbs across sequential BODY[]
emissions on one socket) from "real retention path" (RSS climb persists
after `global.gc()` and shows up on `heapUsed` rather than `external`).

Off by default because prod journald retention already fills quickly under
normal load; a running trace at 5-15 lines per iOS batch triples that. Flip
it on when the next MEMORY_PRESSURE alarm fires, wait for a reproduction, and
flip it back off.

## What this repo does NOT ship (still owed)

The root cause investigation the issue's Candidate hypotheses table lists is
not closed by this PR. In particular:

- **`--expose-gc --trace-gc` build.** The current Dockerfile does not pass
  either flag to Node, so `global.gc()` is not callable and V8's GC trace
  output is off. Neither the "GC lag" nor the "real retention" hypothesis
  can be discriminated on the live artifact.
- **Sandbox reproduction script.** The reproduction the issue names — a
  pipelined burst of 20 `UID FETCH X (UID BODY)` on one connection against a
  seeded 1.5 MB-body mailbox — does not exist in tree. Both `IMAP_MEM_TRACE`
  and the RSS soft-guard were built to be exercised against it, but the
  script itself is a follow-up.
- **Heap snapshot / retained-set diff.** `heap.writeSnapshot()` between two
  successive BODY[] emissions on the same socket, diffed for retained-set
  growth, would separate a bounded allocation from a leaking one. This is
  the definitive test and is not yet automated.

Everything the RSS soft-guard does is **degrade one socket instead of
crashing the whole container**. It does not lower peak allocation; it does
not identify the leak, if there is one. The bug is still open.

## Related material

- The tracking issue on GitHub carries the corrections, the DB-verified
  hits (99.93% `rfc822_size` populated, 100% `text_line_count` / 
  `html_line_count`), and the confirmed live code path
  (`buildMessageSegments`, `pgTextChunks`, `emitBase64`).
- `src/server/lib/imap/mem-guard.ts` — the predicate, the env-var reader,
  the trace-line formatter.
- `src/server/lib/imap/session.ts::fetchMessagesTyped` — where the guard
  runs.
- `src/server/lib/imap/fetch-helpers.ts::writeFetchResponse` — where the
  instrumentation emits, per stream part.
