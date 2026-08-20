import assert from 'node:assert/strict'

import { normalizeTelemetryPacket } from '../src/modules/telemetry/telemetry.routes.js'

const invalid = normalizeTelemetryPacket({ raw: -2000.1, weight_valid: true })
assert.equal(invalid.weightValid, false, 'raw weight below -2000 must be invalid')

const boundary = normalizeTelemetryPacket({ raw: -2000, weight_valid: true })
assert.equal(boundary.weightValid, true, 'raw weight exactly -2000 must remain valid')

const missingRaw = normalizeTelemetryPacket({ weight_valid: true })
assert.equal(missingRaw.weightValid, true, 'missing raw weight must preserve the reported validity')

const reportedInvalid = normalizeTelemetryPacket({ raw: 100, weight_valid: false })
assert.equal(reportedInvalid.weightValid, false, 'an invalid HOST flag must remain invalid')

console.log('Raw weight validity test passed')
