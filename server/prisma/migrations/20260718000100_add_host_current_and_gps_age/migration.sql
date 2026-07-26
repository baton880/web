ALTER TABLE "Telemetry" ADD COLUMN "gpsAgeS" REAL;

CREATE TABLE "DeviceCurrentTelemetry" (
  "deviceId" TEXT NOT NULL PRIMARY KEY,
  "telemetryId" INTEGER NOT NULL,
  "sourceStreamId" TEXT,
  "sourcePacketId" INTEGER,
  "receivedAt" DATETIME NOT NULL,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "DeviceCurrentTelemetry_telemetryId_fkey"
    FOREIGN KEY ("telemetryId") REFERENCES "Telemetry" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "DeviceCurrentTelemetry_telemetryId_key"
ON "DeviceCurrentTelemetry"("telemetryId");

CREATE INDEX "DeviceCurrentTelemetry_receivedAt_idx"
ON "DeviceCurrentTelemetry"("receivedAt");
