import type { TripInput } from '../../src/types/trip.js'

export type RankingTheme = 'culture' | 'coffee' | 'outdoor'

export type CandidateRankingContext = {
  themes: RankingTheme[]
  avoidCoffee: boolean
  customStatus: 'not_used' | 'recognized' | 'unknown'
}

const CULTURE = '(?:博物館|美術館|文化景點|文化展覽|美術展覽|文化活動|展覽)'
const COFFEE_VENUE = '(?:咖啡廳|咖啡館|咖啡店)'
const OUTDOOR = '(?:戶外景點|戶外活動|戶外走走|戶外|公園|步道)'
const VISIT = '(?:(?:這次)?(?:想要?|希望|打算)(?:去|到|找|參觀|逛|看)|(?:途中|順便)?(?:去|到|找|參觀|逛|看))'
const cultureVisit = new RegExp(`^${VISIT}${CULTURE}$`)
const coffeeVisit = new RegExp(`^${VISIT}${COFFEE_VENUE}$`)
const outdoorVisit = new RegExp(`^${VISIT}${OUTDOOR}(?:走走)?$`)
const coffeeAvoidance = new RegExp(`^(?:完全)?(?:(?:這次)?(?:不想|不願|不要|不希望)(?:再)?(?:去|到|找|逛)|(?:這次)?(?:避開|不去|別去|不要))${COFFEE_VENUE}$`)
const coffeeDrink = /^(?:(?:這次)?(?:想要?|希望|打算)喝|(?:途中|順便)?喝)(?:一杯)?咖啡$/
const noCoffeeDrink = /^(?:不喝|不想喝|不要喝)咖啡$/
const cultureNoun = new RegExp(`^${CULTURE}$`)
const coffeeNoun = new RegExp(`^${COFFEE_VENUE}$`)
const outdoorNoun = new RegExp(`^${OUTDOOR}$`)
const cultureCoffeePair = new RegExp(`^(?:(?:文化|${CULTURE})\\+(?:咖啡|${COFFEE_VENUE})|(?:咖啡|${COFFEE_VENUE})\\+(?:文化|${CULTURE}))$`)

// This is a deliberately small visit grammar, not a general free-text parser.
// Unknown clauses or conflicting venue intentions preserve the existing ranking.
export function resolveCandidateRankingContext(input: TripInput): CandidateRankingContext {
  if (input.category !== 'other') {
    return { themes: input.category === 'outdoor' ? ['outdoor'] : [], avoidCoffee: false, customStatus: 'not_used' }
  }

  const unknown: CandidateRankingContext = { themes: [], avoidCoffee: false, customStatus: 'unknown' }
  const text = (input.customCategory ?? '').normalize('NFKC').replace(/\s+/g, '')
  if (cultureCoffeePair.test(text)) {
    return { themes: ['culture', 'coffee'], avoidCoffee: false, customStatus: 'recognized' }
  }
  const clauses = text.split(/(?:並且|[,+。;、與和及並但也])/).filter(Boolean)
  if (!clauses.length) return unknown

  const themes = new Set<RankingTheme>()
  let avoidCoffee = false
  let canContinueVisit = false
  for (const clause of clauses) {
    if (coffeeAvoidance.test(clause)) {
      avoidCoffee = true
      canContinueVisit = false
    } else if (cultureVisit.test(clause) || (canContinueVisit && cultureNoun.test(clause))) {
      themes.add('culture')
      canContinueVisit = true
    } else if (coffeeVisit.test(clause) || coffeeDrink.test(clause) || (canContinueVisit && coffeeNoun.test(clause))) {
      themes.add('coffee')
      canContinueVisit = true
    } else if (outdoorVisit.test(clause) || (canContinueVisit && outdoorNoun.test(clause))) {
      themes.add('outdoor')
      canContinueVisit = true
    } else if (noCoffeeDrink.test(clause)) {
      // A drink choice establishes no positive or negative venue preference.
      canContinueVisit = false
    } else return unknown
  }
  if (avoidCoffee && themes.has('coffee')) return unknown
  if (!themes.size && !avoidCoffee) return unknown
  return { themes: [...themes], avoidCoffee, customStatus: 'recognized' }
}

export type VisitRequirement = { theme: RankingTheme; label: string; cultureTypes?: string[] }

// Refine only an already recognised visit; this does not introduce a second grammar.
// Broad preset categories remain ranking preferences, not mandatory venue requests.
export function resolveVisitRequirements(input: TripInput): VisitRequirement[] {
  const context = resolveCandidateRankingContext(input)
  if (context.customStatus !== 'recognized') return []
  const text = (input.customCategory ?? '').normalize('NFKC')
  return context.themes.flatMap<VisitRequirement>(theme => {
    if (theme === 'coffee') return [{ theme, label: '咖啡廳' }]
    if (theme === 'outdoor') return [{ theme, label: '戶外景點' }]
    const cultureTypes: string[] = []
    if (/博物館/.test(text)) cultureTypes.push('museum')
    if (/美術館|美術展覽/.test(text)) cultureTypes.push('art_gallery')
    return cultureTypes.length ? cultureTypes.map(type => ({ theme,
      label: type === 'museum' ? '博物館' : '美術展覽', cultureTypes: [type],
    })) : [{ theme, label: '文化活動', cultureTypes: [] }]
  })
}
