# Directory structure

- `src`: React build source code
  - `src/client`: React components. Subdirectories follow mounting order.
  - `src/server`: All component modules that powers backend server
    - `src/server/routes`: Routing modules that determines API paths and entrypoints.
    - `src/server/lib`: Lower level modules that functions in between routers and database.
- `public`: React public files

# CLI scripts

- `npm start`: Builds and runs (production mode)
- `npm build`: Builds server & client
- `npm run dev`: Runs server & client separately without building (development mode)
- `npm run dev-server`: Runs backend server only in development mode
- `npm run dev-clientfront`: Runs frontend server only in development mode
