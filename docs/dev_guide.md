# Directory structure

- `src`: Source code
  - `src/client`: React components. Subdirectories follow mounting order.
  - `src/server`: All component modules that powers backend server
    - `src/server/lib/http`: Express server, middleware and API route handlers (`src/server/lib/http/routes`).
    - `src/server/lib/imap`: IMAP server implementation.
    - `src/server/lib/smtp`: SMTP server implementation.
    - `src/server/lib/mails`: Mail processing and Mailgun integration.
    - `src/server/lib/postgres`: Database layer (client, models, repositories).
- `public`: Static assets served by the client build.

# CLI scripts

- `bun start`: Builds and runs (production mode)
- `bun run build`: Builds server & client
- `bun run dev`: Runs server & client separately without building (development mode)
- `bun run dev-server`: Runs backend server only in development mode
- `bun run dev-client`: Runs frontend server only in development mode
- `bun run typecheck`: Type-check the codebase without emitting
- `bun test`: Run the test suite
