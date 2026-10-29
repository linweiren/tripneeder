import assert from 'node:assert/strict'
import { CANDIDATE_TYPES_PROMPT_GUIDANCE as guidance, getCandidateTypesPromptEvidence }
  from '../../../api/_lib/candidate-types-prompt-evidence.ts'

// Historical Search/Ranking snapshots predate this append-only evidence. Validate
// the actual new fields first, then compare the unchanged legacy text/lengths.
// No candidate, ranking, purpose, opening, meal or external-call assertion is removed.
export function legacyComparableCandidatePrompt(api, pool) {
  const actual = api.formatNearbyRecommendations(pool)
  const hasGuide = actual.endsWith(`\n\n${guidance}`)
  assert.equal(actual.split(guidance).length - 1, hasGuide ? 1 : 0)
  const known = new Map(api.getPromptCandidateSelection(pool).promptCandidates.map(c => [c.placeId, c]))
  let additions = 0
  const legacy = (hasGuide ? actual.slice(0, -guidance.length - 2) : actual).split('\n').map(line => {
    const match = /^- name=.*placeId="([^"]+)".*, placeTypes="([^"]*)"$/.exec(line)
    if (!match) return line
    const candidate = known.get(match[1])
    assert.ok(candidate, 'evidence must belong to an actually exposed candidate')
    const tags = match[2].split(',')
    assert.ok(tags.length > 0 && tags.length <= 4 && match[2].length <= 96)
    assert.ok(tags.every(type => candidate.types?.includes(type)), 'never invent a Google type')
    assert.deepEqual(tags, getCandidateTypesPromptEvidence(candidate.types))
    additions++
    return line.slice(0, -`, placeTypes="${match[2]}"`.length)
  }).join('\n')
  assert.equal(hasGuide, additions > 0, 'new fields require exactly one evidence explanation')
  return legacy
}
