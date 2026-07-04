PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Telemetry" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "deviceId" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lat" REAL NOT NULL,
    "lon" REAL NOT NULL,
    "gpsValid" BOOLEAN NOT NULL DEFAULT false,
    "gpsSatellites" INTEGER NOT NULL DEFAULT 0,
    "speedKmh" REAL,
    "weight" REAL NOT NULL,
    "rawWeight" REAL,
    "rawPayload" TEXT NOT NULL,
    "weightValid" BOOLEAN NOT NULL DEFAULT false,
    "gpsQuality" INTEGER NOT NULL DEFAULT 0,
    "wifiClients" TEXT,
    "cpuTempC" REAL,
    "lteRssiDbm" INTEGER,
    "lteAccessTech" TEXT,
    "eventsReaderOk" BOOLEAN NOT NULL DEFAULT false
);

INSERT INTO "new_Telemetry" (
    "id",
    "deviceId",
    "timestamp",
    "receivedAt",
    "lat",
    "lon",
    "gpsValid",
    "gpsSatellites",
    "speedKmh",
    "weight",
    "rawWeight",
    "rawPayload",
    "weightValid",
    "gpsQuality",
    "wifiClients",
    "cpuTempC",
    "lteRssiDbm",
    "lteAccessTech",
    "eventsReaderOk"
)
SELECT
    "id",
    "deviceId",
    "timestamp",
    "timestamp",
    "lat",
    "lon",
    "gpsValid",
    "gpsSatellites",
    "speedKmh",
    "weight",
    "rawWeight",
    '{}',
    "weightValid",
    "gpsQuality",
    "wifiClients",
    "cpuTempC",
    "lteRssiDbm",
    "lteAccessTech",
    "eventsReaderOk"
FROM "Telemetry";

DROP TABLE "Telemetry";
ALTER TABLE "new_Telemetry" RENAME TO "Telemetry";

CREATE INDEX "Telemetry_deviceId_timestamp_idx" ON "Telemetry"("deviceId", "timestamp");
CREATE INDEX "Telemetry_timestamp_idx" ON "Telemetry"("timestamp");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
