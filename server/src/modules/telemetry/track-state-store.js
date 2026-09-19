import { isPostgresDatabase } from '../../prisma-client.js'

const APP_STATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS "AppState" (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL
)
`;

const HOST_TRACK_CLEAR_KEY = 'host_track_clear_since_iso';

let tableReadyPromise = null;

async function ensureAppStateTable(prismaClient) {
  // PostgreSQL application roles intentionally have no schema DDL privileges.
  // The initial migration creates this table before the application starts.
  if (isPostgresDatabase) return
  if (!tableReadyPromise) {
    tableReadyPromise = prismaClient.$executeRawUnsafe(APP_STATE_TABLE_SQL).catch((error) => {
      tableReadyPromise = null;
      throw error;
    });
  }

  await tableReadyPromise;
}

function parseIsoDate(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function getHostTrackClearSince(prismaClient) {
  await ensureAppStateTable(prismaClient);

  const rows = await prismaClient.$queryRaw`
    SELECT value
    FROM "AppState"
    WHERE key = ${HOST_TRACK_CLEAR_KEY}
    LIMIT 1
  `;

  const isoValue = rows?.[0]?.value || null;
  return parseIsoDate(isoValue);
}

export async function setHostTrackClearSince(prismaClient, timestamp = new Date()) {
  await ensureAppStateTable(prismaClient);

  const parsedDate = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const safeDate = Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate;
  const isoValue = safeDate.toISOString();
  const updatedAt = new Date().toISOString();

  await prismaClient.$executeRaw`
    INSERT INTO "AppState" (key, value, "updatedAt")
    VALUES (${HOST_TRACK_CLEAR_KEY}, ${isoValue}, ${updatedAt})
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      "updatedAt" = excluded."updatedAt"
  `;

  return safeDate;
}

