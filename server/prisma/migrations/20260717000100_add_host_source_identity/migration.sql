ALTER TABLE "Telemetry" ADD COLUMN "sourceStreamId" TEXT;
ALTER TABLE "Telemetry" ADD COLUMN "sourcePacketId" INTEGER;

CREATE UNIQUE INDEX "Telemetry_deviceId_sourceStreamId_sourcePacketId_key"
ON "Telemetry"("deviceId", "sourceStreamId", "sourcePacketId");
