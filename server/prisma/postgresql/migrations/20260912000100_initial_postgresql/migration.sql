-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'DIRECTOR', 'GUEST');

-- CreateEnum
CREATE TYPE "ViolationStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'CLOSED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ViolationCategory" AS ENUM ('BUSINESS', 'LEFTOVER', 'TECHNICAL');

-- CreateEnum
CREATE TYPE "TechnicalWarningStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateTable
CREATE TABLE "Telemetry" (
    "id" SERIAL NOT NULL,
    "sourceStreamId" TEXT,
    "sourcePacketId" INTEGER,
    "deviceId" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "gpsValid" BOOLEAN NOT NULL DEFAULT false,
    "gpsSatellites" INTEGER NOT NULL DEFAULT 0,
    "gpsAgeS" DOUBLE PRECISION,
    "speedKmh" DOUBLE PRECISION,
    "weight" DOUBLE PRECISION NOT NULL,
    "rawWeight" DOUBLE PRECISION,
    "rawPayload" TEXT NOT NULL,
    "weightValid" BOOLEAN NOT NULL DEFAULT false,
    "gpsQuality" INTEGER NOT NULL DEFAULT 0,
    "wifiClients" TEXT,
    "cpuTempC" DOUBLE PRECISION,
    "lteRssiDbm" INTEGER,
    "lteAccessTech" TEXT,
    "eventsReaderOk" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Telemetry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceCurrentTelemetry" (
    "deviceId" TEXT NOT NULL,
    "telemetryId" INTEGER NOT NULL,
    "sourceStreamId" TEXT,
    "sourcePacketId" INTEGER,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DeviceCurrentTelemetry_pkey" PRIMARY KEY ("deviceId")
);

-- CreateTable
CREATE TABLE "RtkTelemetry" (
    "id" SERIAL NOT NULL,
    "ingestKey" TEXT,
    "deviceId" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "rtkQuality" TEXT,
    "rtkAge" DOUBLE PRECISION,
    "speed" DOUBLE PRECISION,
    "course" DOUBLE PRECISION,
    "supplyVoltage" DOUBLE PRECISION,
    "satellites" INTEGER,
    "fixType" TEXT,
    "rawPayload" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RtkTelemetry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageZone" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "radius" DOUBLE PRECISION NOT NULL DEFAULT 15.0,
    "shapeType" TEXT NOT NULL DEFAULT 'CIRCLE',
    "sideMeters" DOUBLE PRECISION,
    "polygonCoords" TEXT,
    "squareMinLat" DOUBLE PRECISION,
    "squareMinLon" DOUBLE PRECISION,
    "squareMaxLat" DOUBLE PRECISION,
    "squareMaxLon" DOUBLE PRECISION,
    "loadingWallSide" INTEGER,
    "loadingNormalDeg" DOUBLE PRECISION,
    "zoneType" TEXT NOT NULL DEFAULT 'STORAGE',
    "ingredient" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorageZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceEvent" (
    "id" SERIAL NOT NULL,
    "deviceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL,
    "fromNumber" TEXT NOT NULL,
    "text" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DigestSettings" (
    "id" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "senderEmail" TEXT NOT NULL DEFAULT '',
    "sendTime" TEXT NOT NULL DEFAULT '08:00',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Novosibirsk',
    "recipientsJson" TEXT NOT NULL DEFAULT '[]',
    "lastSentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DigestSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelemetrySettings" (
    "id" INTEGER NOT NULL,
    "batchStartThresholdKg" INTEGER NOT NULL DEFAULT 30,
    "leftoverThresholdKg" INTEGER NOT NULL DEFAULT 50,
    "unloadDropThresholdKg" INTEGER NOT NULL DEFAULT 200,
    "unloadMinPeakKg" INTEGER NOT NULL DEFAULT 400,
    "unloadUpdateDeltaKg" INTEGER NOT NULL DEFAULT 1,
    "unloadWeightBufferKg" INTEGER NOT NULL DEFAULT 50,
    "emptyVehicleThresholdKg" INTEGER NOT NULL DEFAULT 50,
    "autoCloseZeroWeightKg" INTEGER NOT NULL DEFAULT 10,
    "autoCloseEmptyStreak" INTEGER NOT NULL DEFAULT 5,
    "autoCloseNegativeStreak" INTEGER NOT NULL DEFAULT 3,
    "modeUnloadDropHintKg" INTEGER NOT NULL DEFAULT 30,
    "modeLoadingDeltaHintKg" INTEGER NOT NULL DEFAULT 5,
    "anomalyThresholdKg" INTEGER NOT NULL DEFAULT 200,
    "anomalyConfirmDeltaKg" INTEGER NOT NULL DEFAULT 40,
    "anomalyConfirmPackets" INTEGER NOT NULL DEFAULT 3,
    "movementSpeedThresholdKmh" INTEGER NOT NULL DEFAULT 3,
    "movementConfirmPackets" INTEGER NOT NULL DEFAULT 3,
    "loadingZoneStickySeconds" INTEGER NOT NULL DEFAULT 180,
    "zoneChangeDebounceMs" INTEGER NOT NULL DEFAULT 3000,
    "nullZoneConfirmSeconds" INTEGER NOT NULL DEFAULT 120,
    "zoneChangeConfirmPackets" INTEGER NOT NULL DEFAULT 2,
    "zoneDwellScoreCapSeconds" INTEGER NOT NULL DEFAULT 45,
    "zoneEntryFrontBonus" INTEGER NOT NULL DEFAULT 8,
    "zoneEntryRearPenalty" INTEGER NOT NULL DEFAULT 10,
    "zoneEntryFrontAngleDeg" INTEGER NOT NULL DEFAULT 75,
    "zoneEntryRearAngleDeg" INTEGER NOT NULL DEFAULT 120,
    "squareHeadingScorePerSecond" INTEGER NOT NULL DEFAULT 2,
    "squareHeadingScoreCap" INTEGER NOT NULL DEFAULT 30,
    "squareHeadingMaxAngleDeg" INTEGER NOT NULL DEFAULT 90,
    "deviationPercentThreshold" INTEGER NOT NULL DEFAULT 10,
    "deviationMinKgThreshold" INTEGER NOT NULL DEFAULT 10,
    "rtkTrackResetTime" TEXT NOT NULL DEFAULT '03:00',
    "rtkHeadingOffsetDeg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "weightCalibrationFactor" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "loaderMaxDistanceMeters" INTEGER NOT NULL DEFAULT 30,
    "loaderOfflineTimeoutMinutes" INTEGER NOT NULL DEFAULT 4,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TelemetrySettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "password" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'GUEST',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ration" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "feedingsPerDay" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Ration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RationIngredient" (
    "id" SERIAL NOT NULL,
    "rationId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "plannedWeight" DOUBLE PRECISION NOT NULL,
    "dryMatterWeight" DOUBLE PRECISION NOT NULL,
    "isCompound" BOOLEAN NOT NULL DEFAULT false,
    "componentsJson" TEXT,

    CONSTRAINT "RationIngredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LivestockGroup" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "headcount" INTEGER NOT NULL,
    "rationId" INTEGER,
    "storageZoneId" INTEGER,
    "lat" DOUBLE PRECISION,
    "lon" DOUBLE PRECISION,
    "radius" DOUBLE PRECISION NOT NULL DEFAULT 30.0,

    CONSTRAINT "LivestockGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Batch" (
    "id" SERIAL NOT NULL,
    "deviceId" TEXT NOT NULL,
    "startTime" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endTime" TIMESTAMPTZ(3),
    "rationId" INTEGER,
    "groupId" INTEGER,
    "startWeight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "endWeight" DOUBLE PRECISION,
    "hasViolations" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BatchIngredient" (
    "id" SERIAL NOT NULL,
    "batchId" INTEGER NOT NULL,
    "ingredientName" TEXT NOT NULL,
    "plannedWeight" DOUBLE PRECISION,
    "actualWeight" DOUBLE PRECISION NOT NULL,
    "startedAt" TIMESTAMPTZ(3),
    "startLat" DOUBLE PRECISION,
    "startLon" DOUBLE PRECISION,
    "endLat" DOUBLE PRECISION,
    "endLon" DOUBLE PRECISION,
    "isViolation" BOOLEAN NOT NULL DEFAULT false,
    "addedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BatchIngredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Violation" (
    "id" SERIAL NOT NULL,
    "batchId" INTEGER,
    "deviceId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "componentKey" TEXT NOT NULL DEFAULT '',
    "componentName" TEXT,
    "message" TEXT NOT NULL,
    "category" "ViolationCategory" NOT NULL DEFAULT 'BUSINESS',
    "status" "ViolationStatus" NOT NULL DEFAULT 'OPEN',
    "source" TEXT NOT NULL DEFAULT 'system',
    "planWeight" DOUBLE PRECISION,
    "actualWeight" DOUBLE PRECISION,
    "deviation" DOUBLE PRECISION,
    "deviationPercent" DOUBLE PRECISION,
    "detectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),
    "comment" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Violation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TechnicalWarning" (
    "id" SERIAL NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "deviceId" TEXT,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" "TechnicalWarningStatus" NOT NULL DEFAULT 'OPEN',
    "detailsJson" TEXT,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TechnicalWarning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppState" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL,

    CONSTRAINT "AppState_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "LoaderTask" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "ownerId" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "state" TEXT NOT NULL,

    CONSTRAINT "LoaderTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoaderTaskEvent" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "receivedAt" BIGINT NOT NULL,
    "payload" TEXT NOT NULL,

    CONSTRAINT "LoaderTaskEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoaderTerminal" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "ownerId" INTEGER NOT NULL,
    "keyHash" TEXT NOT NULL,
    "passwordVersion" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "lastSeenAt" BIGINT,
    "revokedAt" BIGINT,

    CONSTRAINT "LoaderTerminal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Telemetry_deviceId_timestamp_idx" ON "Telemetry"("deviceId", "timestamp");

-- CreateIndex
CREATE INDEX "Telemetry_timestamp_idx" ON "Telemetry"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "Telemetry_deviceId_sourceStreamId_sourcePacketId_key" ON "Telemetry"("deviceId", "sourceStreamId", "sourcePacketId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceCurrentTelemetry_telemetryId_key" ON "DeviceCurrentTelemetry"("telemetryId");

-- CreateIndex
CREATE INDEX "DeviceCurrentTelemetry_receivedAt_idx" ON "DeviceCurrentTelemetry"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RtkTelemetry_ingestKey_key" ON "RtkTelemetry"("ingestKey");

-- CreateIndex
CREATE INDEX "RtkTelemetry_deviceId_timestamp_idx" ON "RtkTelemetry"("deviceId", "timestamp");

-- CreateIndex
CREATE INDEX "RtkTelemetry_timestamp_idx" ON "RtkTelemetry"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Ration_name_key" ON "Ration"("name");

-- CreateIndex
CREATE INDEX "Violation_deviceId_detectedAt_idx" ON "Violation"("deviceId", "detectedAt");

-- CreateIndex
CREATE INDEX "Violation_status_detectedAt_idx" ON "Violation"("status", "detectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Violation_batchId_code_componentKey_key" ON "Violation"("batchId", "code", "componentKey");

-- CreateIndex
CREATE INDEX "TechnicalWarning_status_lastSeenAt_idx" ON "TechnicalWarning"("status", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "TechnicalWarning_scopeKey_code_key" ON "TechnicalWarning"("scopeKey", "code");

-- CreateIndex
CREATE INDEX "LoaderTask_deviceId_createdAt_idx" ON "LoaderTask"("deviceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LoaderTaskEvent_taskId_revision_key" ON "LoaderTaskEvent"("taskId", "revision");

-- CreateIndex
CREATE INDEX "LoaderTerminal_ownerId_idx" ON "LoaderTerminal"("ownerId");

-- AddForeignKey
ALTER TABLE "DeviceCurrentTelemetry" ADD CONSTRAINT "DeviceCurrentTelemetry_telemetryId_fkey" FOREIGN KEY ("telemetryId") REFERENCES "Telemetry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RationIngredient" ADD CONSTRAINT "RationIngredient_rationId_fkey" FOREIGN KEY ("rationId") REFERENCES "Ration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LivestockGroup" ADD CONSTRAINT "LivestockGroup_rationId_fkey" FOREIGN KEY ("rationId") REFERENCES "Ration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LivestockGroup" ADD CONSTRAINT "LivestockGroup_storageZoneId_fkey" FOREIGN KEY ("storageZoneId") REFERENCES "StorageZone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_rationId_fkey" FOREIGN KEY ("rationId") REFERENCES "Ration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "LivestockGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchIngredient" ADD CONSTRAINT "BatchIngredient_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Violation" ADD CONSTRAINT "Violation_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Preserve the one-active-task constraint from the SQLite journal.
CREATE UNIQUE INDEX LoaderTask_one_active ON "LoaderTask" ("deviceId") WHERE status IN ('ready', 'active');
