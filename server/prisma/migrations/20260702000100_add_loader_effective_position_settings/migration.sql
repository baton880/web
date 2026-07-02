ALTER TABLE "TelemetrySettings" ADD COLUMN "loaderMaxDistanceMeters" INTEGER NOT NULL DEFAULT 150;
ALTER TABLE "TelemetrySettings" ADD COLUMN "loaderOfflineTimeoutMinutes" INTEGER NOT NULL DEFAULT 15;
