const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type TripRecordDeleteFilters = Array<[column: string, value: string]>

export function buildFavoriteDeleteFilters(
  recordId: string,
  userId: string,
  fingerprint: string,
): TripRecordDeleteFilters[] {
  const baseFilters: TripRecordDeleteFilters = [
    ['user_id', userId],
    ['kind', 'favorite'],
  ]
  const deleteFilters: TripRecordDeleteFilters[] = []

  if (UUID_PATTERN.test(recordId)) {
    deleteFilters.push([...baseFilters, ['id', recordId]])
  }

  if (fingerprint) {
    deleteFilters.push([...baseFilters, ['plan_fingerprint', fingerprint]])
  }

  return deleteFilters
}
