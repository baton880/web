import assert from 'node:assert/strict'

import { detectWeightStepMarkup } from '../src/modules/batches/weight-step-postprocess.js'

function telemetryWithStep({ stationaryBefore = false, stationaryAfter = false } = {}) {
  const origin = Date.parse('2026-07-12T00:00:00.000Z')
  return Array.from({ length: 121 }, (_, index) => {
    const seconds = index * 2
    // Give the configured median speed filter enough surrounding samples;
    // the assertion below still checks evidence inside the 10-second boundary window.
    const beforeStop = stationaryBefore && seconds >= 20 && seconds < 60
    const afterStop = stationaryAfter && seconds > 60 && seconds <= 100
    return {
      id: index + 1,
      timestamp: new Date(origin + seconds * 1000),
      rawWeight: seconds < 60 ? 0 : 50,
      weight: seconds < 60 ? 0 : 50,
      weightValid: true,
      speedKmh: beforeStop || afterStop ? 0 : 5,
      lat: 55,
      lon: 83
    }
  })
}

function analyze(rows) {
  return detectWeightStepMarkup({
    startTime: rows[0].timestamp,
    endTime: rows[rows.length - 1].timestamp
  }, rows, {
    weightScale: 1,
    boundaryMinExtendMs: 0,
    loadForceKg: 120,
    loadMovingMaxPct: 60,
    loadBoundaryStopWindowSec: 20,
    loadBoundaryStopSpeedKmh: 0.5,
    loadBoundaryStopMinPoints: 2
  })
}

const movingOnly = analyze(telemetryWithStep())
assert.equal(movingOnly.includedEvents.filter((event) => event.delta > 0).length, 0)
assert.equal(movingOnly.events.some((event) => event.artifactReason === 'moving-load-percent'), true)

const stoppedBefore = analyze(telemetryWithStep({ stationaryBefore: true }))
assert.equal(stoppedBefore.includedEvents.filter((event) => event.delta > 0).length, 0)
assert.equal(stoppedBefore.events.some((event) => event.boundaryStopBefore), false)

const stoppedAfter = analyze(telemetryWithStep({ stationaryAfter: true }))
assert.equal(stoppedAfter.includedEvents.filter((event) => event.delta > 0).length, 1)
assert.equal(stoppedAfter.includedEvents[0].boundaryStopAfter, true)

console.log('PASS only post-load boundary stop can preserve a moving load')
