import assert from 'node:assert/strict'
import { normalizeTelemetryPacket } from '../src/modules/telemetry/telemetry.routes.js'
import { parseHostTimestamp } from '../src/modules/telemetry/host-timestamp.js'
import { FARM_TIME_ZONE, getFarmDateString } from '../src/utils/farm-date.js'

const expectedUtc = '2026-08-21T17:48:10.000Z'

assert.equal(
  parseHostTimestamp('2026-08-21T17:48:10').toISOString(),
  expectedUtc,
  'a zone-less HOST timestamp must be interpreted as UTC'
)
assert.equal(
  parseHostTimestamp('2026-08-21 17:48:10.000').toISOString(),
  expectedUtc,
  'the legacy space-separated HOST timestamp must be interpreted as UTC'
)
assert.equal(
  parseHostTimestamp('2026-08-21T17:48:10Z').toISOString(),
  expectedUtc,
  'an explicit UTC suffix must remain unchanged'
)
assert.equal(
  parseHostTimestamp('2026-08-21T20:48:10+03:00').toISOString(),
  expectedUtc,
  'an explicit numeric offset must remain authoritative'
)
assert.equal(
  normalizeTelemetryPacket({ timestamp: '2026-08-21T17:48:10' }).timestamp.toISOString(),
  expectedUtc,
  'the shared HOST packet normalization must apply the UTC rule'
)
assert.equal(
  parseHostTimestamp(undefined, new Date('2026-08-21T17:48:11Z')).toISOString(),
  '2026-08-21T17:48:11.000Z',
  'missing timestamps must preserve the existing receive-time fallback behavior'
)
assert.ok(Number.isNaN(parseHostTimestamp('not-a-date').getTime()), 'invalid timestamps must remain invalid')

const parsedHostTime = parseHostTimestamp('2026-08-21T17:48:10')
assert.equal(getFarmDateString(parsedHostTime), '2026-08-22', 'HOST packets must be assigned to the Biysk farm day')
const biyskParts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
  timeZone: FARM_TIME_ZONE,
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
}).formatToParts(parsedHostTime).map((part) => [part.type, part.value]))
assert.deepEqual(
  { day: biyskParts.day, hour: biyskParts.hour, minute: biyskParts.minute, second: biyskParts.second },
  { day: '22', hour: '00', minute: '48', second: '10' },
  'the corrected absolute timestamp must display in Biysk (UTC+7)'
)

console.log('Host timestamp tests passed')
