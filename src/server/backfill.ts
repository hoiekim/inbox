/**
 * @deprecated This file was used for Elasticsearch backfilling.
 * It is no longer needed after migration to PostgreSQL.
 * Keeping for historical reference only.
 */

import "./config";

console.warn("This backfill script is deprecated.");
console.warn("The application now uses PostgreSQL instead of Elasticsearch.");
console.warn("Run 'npm run migrate' to migrate data from ES to PG.");

const main = async () => {
  // Deprecated - no longer needed
};

if (require.main === module) main();
