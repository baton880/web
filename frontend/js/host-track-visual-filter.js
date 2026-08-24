(function initHostTrackVisualFilter(root) {
    "use strict";

    const DEFAULT_OPTIONS = Object.freeze({
        maxGpsAgeS: 3,
        maxReportedSpeedKmh: 30,
        maxImpliedSpeedKmh: 30,
        minSatellites: 6,
        stabilizationPoints: 3,
    });

    function parseTimestampMs(value) {
        const timestampMs = new Date(value).getTime();
        return Number.isFinite(timestampMs) ? timestampMs : null;
    }

    function parseOptionalNumber(value) {
        if (value === null || value === undefined || value === "") return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function parseBoolean(value) {
        if (typeof value === "boolean") return value;
        if (typeof value === "number") return value !== 0;
        if (typeof value === "string") {
            const normalized = value.trim().toLowerCase();
            if (["true", "1", "yes"].includes(normalized)) return true;
            if (["false", "0", "no"].includes(normalized)) return false;
        }
        return null;
    }

    function calculateDistanceMeters(pointA, pointB) {
        const toRadians = (degrees) => degrees * Math.PI / 180;
        const earthRadiusMeters = 6371000;
        const lat1 = toRadians(pointA.lat);
        const lat2 = toRadians(pointB.lat);
        const deltaLat = toRadians(pointB.lat - pointA.lat);
        const deltaLon = toRadians(pointB.lon - pointA.lon);
        const sinLat = Math.sin(deltaLat / 2);
        const sinLon = Math.sin(deltaLon / 2);
        const a = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;

        return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function normalizePoint(row, index) {
        const lat = Number(row?.lat);
        const lon = Number(row?.lon);
        const timestampMs = parseTimestampMs(row?.timestamp);
        return {
            lat,
            lon,
            timestampMs,
            source: row,
            sourceIndex: index,
            satellites: parseOptionalNumber(row?.gpsSatellites ?? row?.gps_satellites),
            reportedSpeedKmh: parseOptionalNumber(row?.speedKmh ?? row?.speed_kmh ?? row?.speed),
            gpsAgeS: parseOptionalNumber(row?.gpsAgeS ?? row?.gps_age_s),
            gpsValid: parseBoolean(row?.gpsValid ?? row?.gps_valid),
            visualGapBefore: false,
        };
    }

    function getBaseRejectionReason(point, options) {
        if (
            point.timestampMs === null ||
            !Number.isFinite(point.lat) ||
            !Number.isFinite(point.lon) ||
            point.lat === 0 ||
            point.lon === 0 ||
            Math.abs(point.lat) > 90 ||
            Math.abs(point.lon) > 180 ||
            point.gpsValid === false
        ) {
            return "invalid";
        }

        if (point.gpsAgeS !== null && (point.gpsAgeS < 0 || point.gpsAgeS > options.maxGpsAgeS)) {
            return "stale";
        }

        if (point.reportedSpeedKmh !== null && point.reportedSpeedKmh > options.maxReportedSpeedKmh) {
            return "reported_speed";
        }

        if (point.satellites !== null && point.satellites < options.minSatellites) {
            return "satellites";
        }

        return null;
    }

    function calculateImpliedSpeedKmh(previousPoint, currentPoint) {
        if (!previousPoint || !currentPoint) return 0;
        const elapsedSeconds = (currentPoint.timestampMs - previousPoint.timestampMs) / 1000;
        const distanceMeters = calculateDistanceMeters(previousPoint, currentPoint);
        if (elapsedSeconds <= 0) {
            return distanceMeters <= 1 ? 0 : Number.POSITIVE_INFINITY;
        }
        return distanceMeters / elapsedSeconds * 3.6;
    }

    function isPlausibleTransition(previousPoint, currentPoint, options) {
        return calculateImpliedSpeedKmh(previousPoint, currentPoint) <= options.maxImpliedSpeedKmh;
    }

    function filter(historyRows, overrides = {}) {
        const options = {
            ...DEFAULT_OPTIONS,
            ...(overrides || {}),
        };
        options.stabilizationPoints = Math.max(1, Math.round(Number(options.stabilizationPoints) || 1));

        const normalized = (Array.isArray(historyRows) ? historyRows : [])
            .map(normalizePoint)
            .sort((left, right) => {
                const timeDiff = (left.timestampMs ?? Number.POSITIVE_INFINITY) - (right.timestampMs ?? Number.POSITIVE_INFINITY);
                if (timeDiff !== 0) return timeDiff;
                const idDiff = Number(left.source?.id || 0) - Number(right.source?.id || 0);
                return idDiff !== 0 ? idDiff : left.sourceIndex - right.sourceIndex;
            });

        const accepted = [];
        const stats = {
            input: normalized.length,
            accepted: 0,
            rejectedInvalid: 0,
            rejectedStale: 0,
            rejectedReportedSpeed: 0,
            rejectedSatellites: 0,
            rejectedImpliedSpeed: 0,
            recoveryCount: 0,
        };
        let lastTrusted = null;
        let recovering = true;
        let gapPending = false;
        let pending = [];

        const enterRecovery = () => {
            recovering = true;
            pending = [];
            if (lastTrusted) gapPending = true;
        };

        const countBaseRejection = (reason) => {
            if (reason === "invalid") stats.rejectedInvalid += 1;
            else if (reason === "stale") stats.rejectedStale += 1;
            else if (reason === "reported_speed") stats.rejectedReportedSpeed += 1;
            else if (reason === "satellites") stats.rejectedSatellites += 1;
        };

        const acceptPoint = (point, visualGapBefore = false) => {
            const acceptedPoint = {
                ...point,
                visualGapBefore: Boolean(visualGapBefore),
            };
            accepted.push(acceptedPoint);
            lastTrusted = acceptedPoint;
        };

        normalized.forEach((point) => {
            const rejectionReason = getBaseRejectionReason(point, options);
            if (rejectionReason) {
                countBaseRejection(rejectionReason);
                enterRecovery();
                return;
            }

            if (!recovering) {
                if (!isPlausibleTransition(lastTrusted, point, options)) {
                    stats.rejectedImpliedSpeed += 1;
                    enterRecovery();
                    return;
                }
                acceptPoint(point);
                return;
            }

            if (lastTrusted && !isPlausibleTransition(lastTrusted, point, options)) {
                stats.rejectedImpliedSpeed += 1;
                pending = [];
                return;
            }

            if (pending.length && !isPlausibleTransition(pending[pending.length - 1], point, options)) {
                stats.rejectedImpliedSpeed += 1;
                pending = [];
            }

            pending.push(point);
            if (pending.length < options.stabilizationPoints) return;

            pending.forEach((pendingPoint, index) => {
                acceptPoint(pendingPoint, gapPending && index === 0);
            });
            if (gapPending) stats.recoveryCount += 1;
            recovering = false;
            gapPending = false;
            pending = [];
        });

        stats.accepted = accepted.length;
        return { points: accepted, stats, options };
    }

    root.HostTrackVisualFilter = Object.freeze({
        DEFAULT_OPTIONS,
        calculateDistanceMeters,
        calculateImpliedSpeedKmh,
        filter,
    });
})(typeof window !== "undefined" ? window : globalThis);
