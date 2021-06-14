# Directory structure

- `src`: React build source code
  - Subdirectory structure follows React components' mounting structure
- `public`: React public files
- `lib`: Mails & database handling modules for backend server
  - `lib/components/elastic.js`: Elasticsearch class (initialize & send request to Es, etc.)
  - `lib/mails.js`: Email module (save, send, get accounts list, etc.)
- `routes`: Routing modules for backend server
  - `routes/mails.js`: Email C/R/U/D, etc. router
  - `routes/user.js`: Login/out router
- `server.js`: Server that handles all routes and ports

# CLI scripts

- `npm start`: Builds and runs (production mode)
- `npm run dev`: Runs back & front separately without building (development mode)
- `npm back`: Runs backend server only
- `npm front`: Runs frontend server only
