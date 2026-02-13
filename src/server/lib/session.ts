// Re-export the PostgreSQL session store
export {
  PostgresSessionStore,
  searchSession,
  updateSession,
  deleteSession,
  purgeSessions,
} from "./postgres/repositories/sessions";

// Alias for backwards compatibility
export { PostgresSessionStore as ElasticsearchSessionStore } from "./postgres/repositories/sessions";
