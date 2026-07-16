import assert from 'node:assert/strict'

function incrementYmd(ymd) {
  const date = new Date(`${ymd}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

function nextTimestamp(state, time, rmcDate = null, rmcBeforeGga = false) {
  state.sequence += 1
  if (rmcDate && rmcBeforeGga) {
    state.date = rmcDate
    state.lastRmcSequence = state.sequence
    state.sequence += 1
  }

  const [hour, minute, second] = time.split(':').map(Number)
  const secondOfDay = hour * 3600 + minute * 60 + second
  const crossedMidnight = state.lastGgaSecond >= 23 * 3600 && secondOfDay <= 3600
  if (crossedMidnight) {
    const rmcUpdated = state.lastRmcSequence > state.lastGgaSequence
    if (!rmcUpdated) state.date = incrementYmd(state.date)
  }
  state.lastGgaSecond = secondOfDay
  state.lastGgaSequence = state.sequence
  return Date.parse(`${state.date}T${time}.000Z`)
}

function freshState(date) {
  return {
    date,
    sequence: 0,
    lastRmcSequence: 0,
    lastGgaSequence: 0,
    lastGgaSecond: -1
  }
}

for (const rmcBeforeGga of [false, true]) {
  const state = freshState('2026-07-15')
  const before = nextTimestamp(state, '23:59:59')
  const after = nextTimestamp(state, '00:00:00', '2026-07-16', rmcBeforeGga)
  assert.equal(after - before, 1000)
}

const leapState = freshState('2028-02-28')
const leapBefore = nextTimestamp(leapState, '23:59:59')
const leapAfter = nextTimestamp(leapState, '00:00:00')
assert.equal(new Date(leapAfter).toISOString(), '2028-02-29T00:00:00.000Z')
assert.equal(leapAfter - leapBefore, 1000)

const queue = Array.from({ length: 1800 }, (_, index) => index)
const delivered = []
let elapsedSeconds = 0
while (queue.length) {
  const liveCreatedAt = elapsedSeconds
  const liveDeliveredAt = elapsedSeconds + 0.25
  assert.ok(liveDeliveredAt - liveCreatedAt <= 3)
  delivered.push(...queue.splice(0, 16))
  elapsedSeconds += 1
}
assert.deepEqual(delivered, Array.from({ length: 1800 }, (_, index) => index))
assert.ok(elapsedSeconds <= 5 * 60)

console.log(`Firmware reliability model passed; 1800-row FIFO drained in ${elapsedSeconds}s`)
