ALTER TABLE "StorageZone" ADD COLUMN "loadingWallSide" INTEGER;
ALTER TABLE "StorageZone" ADD COLUMN "loadingNormalDeg" REAL;

ALTER TABLE "TelemetrySettings" ADD COLUMN "zoneDwellScoreCapSeconds" INTEGER NOT NULL DEFAULT 45;
ALTER TABLE "TelemetrySettings" ADD COLUMN "zoneEntryFrontBonus" INTEGER NOT NULL DEFAULT 8;
ALTER TABLE "TelemetrySettings" ADD COLUMN "zoneEntryRearPenalty" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "TelemetrySettings" ADD COLUMN "zoneEntryFrontAngleDeg" INTEGER NOT NULL DEFAULT 75;
ALTER TABLE "TelemetrySettings" ADD COLUMN "zoneEntryRearAngleDeg" INTEGER NOT NULL DEFAULT 120;
ALTER TABLE "TelemetrySettings" ADD COLUMN "squareHeadingScorePerSecond" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "TelemetrySettings" ADD COLUMN "squareHeadingScoreCap" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "TelemetrySettings" ADD COLUMN "squareHeadingMaxAngleDeg" INTEGER NOT NULL DEFAULT 90;
