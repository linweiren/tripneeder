import test from 'node:test'
import assert from 'node:assert/strict'

import { matchForecastPeriod, normalizeCwaCounty, readCwaElementValue } from '../../api/_lib/weather-parsing.js'

test('normalizes Taiwan county aliases for CWA location matching', () => {
  assert.equal(normalizeCwaCounty('台北市'), '臺北市')
  assert.equal(normalizeCwaCounty('新竹縣竹北市'), '新竹縣')
  assert.equal(normalizeCwaCounty('新竹市東區'), '新竹市')
  assert.equal(normalizeCwaCounty('嘉義縣民雄鄉'), '嘉義縣')
  assert.equal(normalizeCwaCounty('嘉義市東區'), '嘉義市')
  assert.notEqual(normalizeCwaCounty('新竹縣'), normalizeCwaCounty('新竹市'))
  assert.notEqual(normalizeCwaCounty('嘉義縣'), normalizeCwaCounty('嘉義市'))
  assert.equal(normalizeCwaCounty('臺北縣'), '新北市')
  assert.equal(normalizeCwaCounty('花蓮縣'), '花蓮縣')
})

test('matches temperatures and rain to the period containing the forecast time', () => {
  const periods = [
    { startTime: '2026-10-21T00:00:00+08:00', endTime: '2026-10-21T03:00:00+08:00', elementValue: [{ value: '20' }] },
    { startTime: '2026-10-21T03:00:00+08:00', endTime: '2026-10-21T06:00:00+08:00', elementValue: [{ value: '40' }] },
  ]
  const period = matchForecastPeriod(periods, Date.parse('2026-10-21T04:00:00+08:00'))
  assert.equal(period?.elementValue[0].value, '40')
})

test('reads valid numeric CWA values and rejects invalid placeholders', () => {
  assert.equal(readCwaElementValue('18.5'), 18.5)
  assert.equal(readCwaElementValue(''), null)
  assert.equal(readCwaElementValue('X'), null)
})
