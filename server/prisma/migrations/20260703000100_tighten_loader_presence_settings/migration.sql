UPDATE "TelemetrySettings"
SET "loaderMaxDistanceMeters" = 4
WHERE "loaderMaxDistanceMeters" = 150;

UPDATE "TelemetrySettings"
SET "loaderOfflineTimeoutMinutes" = 4
WHERE "loaderOfflineTimeoutMinutes" = 15;
