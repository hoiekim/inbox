# Development Guide

## Quick Start

```bash
# Install dependencies
bun install

# Run tests
bun test

# Run development server (requires PostgreSQL)
bun run dev

# Build for production
bun run build

# Start production server
bun run start
```

## Project Structure

```
src/
├── client/           # React frontend
│   ├── Box/          # Main email UI components
│   ├── ErrorBoundary/ # Error handling
│   ├── lib/          # Client utilities
│   └── App.tsx       # Root component
├── server/           # Backend services
│   ├── lib/
│   │   ├── http/     # Express server + API routes
│   │   │   └── routes/ # API endpoints
│   │   ├── imap/     # IMAP server implementation
│   │   ├── smtp/     # SMTP server implementation
│   │   ├── mails/    # Mail processing utilities
│   │   └── postgres/ # Database layer
│   └── start.ts      # Server entry point
└── common/           # Shared code
    └── models/       # Data models
```

## Services

Inbox runs multiple services:

| Service | Port | Description |
|---------|------|-------------|
| HTTP/API | 3000 | Web UI + REST API |
| IMAP | 143 | IMAP server (non-TLS) |
| IMAP/TLS | 993 | IMAP server (TLS) |
| SMTP | 25 | SMTP server (submission) |
| SMTP/TLS | 587 | SMTP server (STARTTLS) |

## API Patterns

### Route Definition

Routes use Express router with a custom `Route` class:

```typescript
import { Route } from "../route";

export const myRoute = new Route<ResponseType>("POST", "/path", async (req, res) => {
  return { status: "success", body: data };
});
```

### Response Format

```typescript
interface ApiResponse<T> {
  status: "loading" | "streaming" | "success" | "failed" | "error";
  body?: T;
  message?: string;
}
```

### Client-Side API Calls

Use the `call` utility:

```typescript
import { call } from "client";

const { status, body, message } = await call.get<ResponseType>("/api/endpoint");
const { status, body } = await call.post<ResponseType, BodyType>("/api/endpoint", body);
```

## Testing

### Test Requirements (Mandatory)

**Always write unit tests for new code files.** This is a project rule.

- New files: Create a corresponding `*.test.ts` file
- New functions: Add test cases covering expected behavior and edge cases
- Bug fixes: Add regression tests that would have caught the bug
- Security-critical code: Must have tests (auth, parsers, validation)

Check coverage with `bun test --coverage`.

### Running Tests

```bash
bun test                    # All tests
bun test --watch           # Watch mode
bun test src/path/file.test.ts  # Single file
bun test --coverage        # With coverage report
```

### Test Location

Tests are adjacent to source files:
- `src/server/lib/imap/util.test.ts`
- `src/server/lib/imap/index.test.ts`

### IMAP Parser Tests

Security-critical parsers have dedicated test coverage:
- Auth parsers (LOGIN, AUTHENTICATE)
- APPEND parser (message upload)
- Mailbox parsers (SELECT, EXAMINE, STATUS, etc.)

### Test Requirements

**Always write unit tests for new code files.** When adding a new utility, helper, or module:
- Create `<filename>.test.ts` alongside the source file
- Test the public interface and edge cases
- PRs adding new code without tests will require justification

### Bun `mock.module` — Global Scope Warning

**`mock.module()` replaces modules globally for the entire test run**, not just the current test file. This has caused repeated CI failures.

**Rules:**
1. **Mock only what the module under test actually imports.** Don't mock extra exports "just in case" — they leak into other test files.
2. **Never mock utility functions** (`getDomain`, `getUserDomain`, `isValidEmail`) unless the code under test directly calls them.
3. **If a mock must override a barrel** (`'server'`), re-export everything the barrel normally exports to avoid breaking downstream tests.

**Example of the bug pattern:**
```typescript
// ❌ smtp.test.ts mocked 'server' with getDomain: () => 'test.com'
// → mails/util.test.ts also imports getDomain from 'server'
// → getDomain resolves to the mock stub, 4 tests fail

// ✅ Only mock what smtp.ts actually uses
mock.module("server", () => ({
  getUser: mockGetUser,
  saveMailHandler: mockSave,
  sendMail: mockSend,
  // Don't include getDomain — smtp.ts doesn't import it
}));
```

### React Component Cleanup

Always return cleanup functions from `useEffect` when adding event listeners:

```typescript
useEffect(() => {
  const handler = (e: Event) => { /* ... */ };
  window.addEventListener("focus", handler);
  return () => window.removeEventListener("focus", handler);
}, []);
```

## Code Style

### TypeScript

- Avoid `any` - use proper types or `unknown`
- Use explicit return types for exports
- Prefer interfaces for object shapes

### Error Handling

Server routes wrap handlers with try/catch:

```typescript
try {
  const result = await callback(req, res, stream);
  if (result) res.json(result);
} catch (error: any) {
  console.error(error);
  res.status(500).json({ status: "error", message: error?.message });
}
```

### Async Error Propagation

**Don't swallow errors with `.catch(console.error)`.** This pattern silently hides failures:

```typescript
// ❌ Bad - Error is logged but not propagated
await doSomething().catch(console.error);
// Calling code thinks this succeeded

// ✅ Good - Log and re-throw
await doSomething().catch((error) => {
  console.error("Operation failed:", error);
  throw error;  // Propagate to caller
});

// ✅ Good - Let caller handle it
await doSomething();  // Throws naturally
```

This is especially important in background tasks where failures need to be tracked.

### IMAP Implementation Notes

- Sessions track state per connection
- IDLE manager handles long-lived connections with 29-minute refresh
- Parser functions return structured results or throw on invalid input

### IMAP Mailbox Hierarchy

Mailboxes are organized under a flat namespace with `/` as delimiter:

```
INBOX                              ← Unified inbox (all accounts)
accounts/user@example.com          ← Per-account received mail
Sent Messages                     ← Unified sent mail
Sent Messages/accounts/user@...   ← Per-account sent mail
```

Key implementation details (see `src/server/lib/imap/util.ts`):
- `accountToBox()` / `boxToAccount()` map between email addresses and IMAP mailbox names
- `isSentBox()` detects sent-mail mailboxes at any level
- Mailboxes are filtered by user domain — only addresses belonging to the server's domain are exposed
- NAMESPACE response declares `("" "/")` as the personal namespace

### IMAP Client Compatibility

The IMAP server targets compatibility with standard mail clients (Apple Mail, iOS Mail, Thunderbird). Key patterns learned from client testing:

- **BODYSTRUCTURE must match BODY[] encoding**: If BODYSTRUCTURE declares `base64`, the corresponding `BODY[n]` fetch must return base64-encoded content (not raw UTF-8)
- **RFC822.SIZE must account for encoding**: Size should reflect the encoded (wire-format) message size
- **CAPABILITY response must match port**: Port 993 (implicit TLS) must NOT advertise STARTTLS; port 143 must advertise it
- **AUTHENTICATE PLAIN**: Support both inline initial response and challenge-response flow (some clients omit the initial response)
- **Supported extensions**: NAMESPACE (RFC 2342), ENABLE (RFC 5161), UNSELECT (RFC 3691); GETQUOTAROOT returns NO (not supported)
- **Flags on sub-mailboxes**: Per-account mailboxes should NOT have `\Noselect` — clients need to be able to select them

## Database

### PostgreSQL Setup

Configure via environment variables:
- `POSTGRES_HOST`
- `POSTGRES_PORT` (default: 5432)
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `POSTGRES_DB`

### Repository Pattern

Database operations are in `src/server/lib/postgres/repositories/`:

```typescript
import { getMails, saveMail } from "./repositories/mails";
```

### Table Class Methods (IMPORTANT)

**Always use table class methods instead of direct SQL/pool operations.**

```typescript
// ✓ Correct - use table methods
import { sessionsTable } from "./models";
await sessionsTable.deleteByIds(sessionIds);
await sessionsTable.insertOne(sessionData);

// ✗ Avoid - direct pool/SQL usage
import { pool } from "./client";
await pool.query("DELETE FROM sessions WHERE ...");
```

This pattern ensures consistent transaction handling, logging, and type safety.

### Migrations

Schema migrations run automatically on startup via `src/server/lib/postgres/migrate.ts`.

## Security Considerations

### Authentication

- Tokens use `crypto.randomBytes()` (cryptographically secure)
- Rate limiting on auth endpoints (15 min window, 10 attempts)

### Email Display Security

**Email HTML is untrusted content.** Always use iframe sandboxing:

```tsx
<iframe
  srcDoc={processHtmlForViewer(data.html)}
  sandbox="allow-same-origin"
/>
```

The `sandbox` attribute restricts:
- ❌ Script execution (no JS in emails)
- ❌ Form submissions
- ❌ Popups and new windows
- ❌ Top navigation hijacking
- ✅ `allow-same-origin` enables CSS styling

**Never add `allow-scripts` to email iframes** - this would enable XSS attacks via malicious emails.

Additional defense layers:
- HTML sanitization (planned: #124)
- CSP headers (planned: #151)

### Data Deletion Strategy

Prefer **soft-delete** over hard-delete for user-facing data:

- Mark records as deleted (e.g., `expunged` flag) rather than removing rows
- Soft-deleted records are excluded from normal queries but preserved for recovery
- Hard deletion is reserved for cleanup tasks or explicit user requests

This pattern is used in the IMAP EXPUNGE implementation where deleted messages retain their data until explicitly purged.

### IMAP Security

- Password comparison uses constant-time comparison
- Session IDs are cryptographically random
- Per-user UIDVALIDITY tracking prevents cross-user data leaks

## Query Optimization

### Select Only Needed Columns

**Never `SELECT *` when you only need a subset of columns**, especially for tables with large text/blob columns. The mail table's `text` and `html` columns can be several MB per row.

```typescript
// ❌ Bad - loads full mail bodies into memory
const result = await pool.query("SELECT * FROM mails WHERE account_id = $1", [accountId]);

// ✅ Good - select only header columns
const result = await pool.query(
  "SELECT id, account_id, from_address, to_address, subject, date, read, saved, expunged FROM mails WHERE account_id = $1",
  [accountId]
);
```

This pattern was critical in PR #161 where `getMailHeaders` was selecting all columns including mail bodies, causing OOM crashes when accounts had thousands of emails.

**Rule:** Repository functions that return lists should explicitly select only the columns they need.

## Accessibility

### Interactive Elements

**Use semantic HTML for interactive elements.** Clickable `<div>` elements are not keyboard-accessible.

```tsx
// ❌ Bad - invisible to keyboard and screen readers
<div className="mail-card" onClick={onClickMail}>

// ✅ Good - focusable, keyboard-accessible, announced as interactive
<button className="mail-card" onClick={onClickMail}>

// ✅ Acceptable - when button styling is impractical
<div role="button" tabIndex={0} onClick={onClickMail}
  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClickMail(); }}>
```

### Form Inputs

**Every `<input>` must have an associated label:**

```tsx
<label htmlFor="search">Search</label>
<input id="search" value={query} onChange={onChange} />
// or
<input aria-label="Search emails" value={query} onChange={onChange} />
```

## CI/CD

### Pull Request Checks

- TypeScript type checking
- ESLint linting
- Unit tests

### Deployment

Merges to `main` trigger Docker build and deployment.

## Common Tasks

### Adding a New API Route

1. Create file in `src/server/lib/http/routes/<domain>/`
2. Define route with `new Route<T>(method, path, handler)`
3. Add to domain index file
4. Export response type

### Adding IMAP Commands

1. Add parser in `src/server/lib/imap/parsers/`
2. Add handler in `src/server/lib/imap/session.ts`
3. Add tests for parser
4. Update capabilities if needed

### Testing IMAP Locally

```bash
# Connect via telnet/netcat
nc localhost 143

# Or use openssl for TLS
openssl s_client -connect localhost:993

# Login
a001 LOGIN user@domain.com password
a002 SELECT INBOX
a003 FETCH 1:* FLAGS
```
