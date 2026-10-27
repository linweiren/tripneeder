// Explicit transport-contract delta. Itinerary quality and paid provider calls
// remain compared exactly; old provisional content becomes metadata only.
export function paidEventsFromLegacy(events) {
  return events.flatMap(event => event.event === 'plan'
    ? [{ event: 'progress', style: event.plan.type, stage: 'validating' }]
    : event.event === 'done' ? [...event.response.plans.map(plan => ({ event: 'plan', plan })), event] : [event])
}

export function withoutPaymentPersistence(calls) {
  return calls.filter(call => {
    const url = new URL(call.url)
    return !(url.hostname === 'unit-test.supabase.co' && (url.pathname === '/auth/v1/user'
      || /\/(claim_trip_generation|complete_paid_trip_generation|fail_trip_generation|consume_points_for_analysis|trip_generations)$/.test(url.pathname)))
  }).map(call => {
    if (!call.init) return call
    const { signal: _cancellationSignal, ...init } = call.init
    return { ...call, init }
  })
}
