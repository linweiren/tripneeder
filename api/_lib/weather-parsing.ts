export type TimedValue = {
  startTime?: string
  endTime?: string
  elementValue?: Array<{ value?: string }>
}

export function normalizeCwaCounty(value: string) {
  const normalized = value.trim().replace(/台/g, '臺').replace(/[\s縣市]+$/g, '')
  const aliases: Record<string, string> = {
    臺北: '臺北', 新北: '新北', 桃園: '桃園', 臺中: '臺中', 臺南: '臺南', 臺東: '臺東',
  }
  return aliases[normalized] ?? normalized
}

export function matchForecastPeriod<T extends TimedValue>(periods: T[], timestamp: number): T | undefined {
  let closest: T | undefined
  let closestDistance = Number.POSITIVE_INFINITY
  for (const period of periods) {
    const start = Date.parse(period.startTime ?? '')
    const end = Date.parse(period.endTime ?? '')
    if (Number.isFinite(start) && Number.isFinite(end) && timestamp >= start && timestamp < end) return period
    if (Number.isFinite(start) && Math.abs(timestamp - start) < closestDistance) {
      closest = period
      closestDistance = Math.abs(timestamp - start)
    }
  }
  return closestDistance <= 3 * 60 * 60 * 1000 ? closest : undefined
}

export function readCwaElementValue(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^-?\d+(?:\.\d+)?$/)
  return match ? Number(match[0]) : null
}
