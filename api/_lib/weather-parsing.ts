export type TimedValue = {
  startTime?: string
  endTime?: string
  elementValue?: Array<{ value?: string }>
}

export function normalizeCwaCounty(value: string) {
  const normalized = value.trim().replace(/台/g, '臺').replace(/\s+/g, '')
  const legacyAliases: Record<string, string> = { 臺北縣: '新北市' }
  const countyCities = [
    '基隆市', '臺北市', '新北市', '桃園市', '新竹市', '新竹縣', '苗栗縣', '臺中市',
    '彰化縣', '南投縣', '雲林縣', '嘉義市', '嘉義縣', '臺南市', '高雄市', '屏東縣',
    '宜蘭縣', '花蓮縣', '臺東縣', '澎湖縣', '金門縣', '連江縣',
  ]
  if (legacyAliases[normalized]) return legacyAliases[normalized]
  return countyCities.find((countyCity) => normalized === countyCity || normalized.startsWith(countyCity)) ?? normalized
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
