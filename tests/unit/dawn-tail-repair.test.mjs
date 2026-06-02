import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getDawnTailMinimumRequiredActualMinutes,
  isTailStopNearDawnTripEnd,
  shouldAllowDawnTailShortfall,
} from '../../api/generate-trip.ts'

test('cross-day trips ending from 05:30 through 07:00 allow dawn tail shortfall', () => {
  const expectedMinimums = new Map([
    ['05:30', 396],
    ['06:00', 420],
    ['06:30', 444],
    ['07:00', 468],
  ])

  for (const [endTime, minimumMinutes] of expectedMinimums) {
    const tripInput = input('20:00', endTime)

    assert.equal(shouldAllowDawnTailShortfall(tripInput), true)
    assert.equal(getDawnTailMinimumRequiredActualMinutes(tripInput), minimumMinutes)
  }
})

test('cross-day trips ending after the dawn repair window keep strict coverage', () => {
  const tripInput = input('20:00', '08:00')

  assert.equal(shouldAllowDawnTailShortfall(tripInput), false)
})

test('dawn tail repair only targets stops near the cross-day end time', () => {
  const nearEndPlan = plan([
    stop('a', 120),
    stop('b', 120),
    stop('tail', 60),
  ], [18, 18])

  assert.equal(isTailStopNearDawnTripEnd(nearEndPlan, input('23:30', '06:00')), true)

  const earlierTailPlan = plan([
    stop('a', 45),
    stop('tail', 45),
  ], [18])

  assert.equal(isTailStopNearDawnTripEnd(earlierTailPlan, input('23:30', '06:00')), false)
})

function input(startTime, endTime) {
  return {
    startTime,
    endTime,
    tags: [],
    location: { name: 'test' },
  }
}

function plan(stops, segmentDurations) {
  return {
    id: 'safe',
    type: 'safe',
    title: '',
    subtitle: '',
    summary: '',
    totalTime: 0,
    budget: 0,
    transportMode: 'scooter',
    stops,
    transportSegments: segmentDurations.map((duration, index) => ({
      fromStopId: stops[index].id,
      toStopId: stops[index + 1].id,
      mode: 'scooter',
      duration,
      label: '',
    })),
    rainBackup: [],
    rainTransportSegments: [],
  }
}

function stop(id, duration) {
  return {
    id,
    name: id,
    type: 'main_activity',
    description: '',
    address: '',
    duration,
  }
}
