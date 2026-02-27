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

### Running Tests

```bash
bun test                    # All tests
bun test --watch           # Watch mode
bun test src/path/file.test.ts  # Single file
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
  res.status(500).json({ status: "error", info: error?.message });
}
```

### IMAP Implementation Notes

- Sessions track state per connection
- IDLE manager handles long-lived connections with 29-minute refresh
- Parser functions return structured results or throw on invalid input

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

### Migrations

Schema migrations run automatically on startup via `src/server/lib/postgres/migrate.ts`.

## Security Considerations

### Authentication

- Tokens use `crypto.randomBytes()` (cryptographically secure)
- Rate limiting on auth endpoints (15 min window, 10 attempts)

### IMAP Security

- Password comparison uses constant-time comparison
- Session IDs are cryptographically random
- Per-user UIDVALIDITY tracking prevents cross-user data leaks

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
