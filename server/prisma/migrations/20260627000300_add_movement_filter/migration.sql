ALTER TABLE "TelemetrySettings" ADD COLUMN "movementSpeedThresholdKmh" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "TelemetrySettings" ADD COLUMN "movementConfirmPackets" INTEGER NOT NULL DEFAULT 3;
