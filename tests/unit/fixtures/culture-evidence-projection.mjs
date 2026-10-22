// Projection-only capture from real run db8ff9ce-96d3-4b22-8527-4dc081ef548e, dev 342847c.
// No account, history events, Prompt text or credentials. This is the 38 exposed
// candidates, NOT a reconstructed search pool or a full itinerary replay.
// Columns: placeId, name, types, role, score, distanceKm, slots, observed foodSubtype.
// Missing foodSubtype stays unknown; unrecorded addresses/hours are not invented.
const rows = [
  ["ChIJH84gKYgEbjQRm8xsvOZ5rKM","草圖自家烘焙咖啡館 Sketch cafe & Roastery.",["cafe","coffee_roastery","dessert_shop","confectionery","wholesaler","food_store","store","food","point_of_interest","service","establishment"],"food",113.8,0.649867547115671,["early","middle","late"],"cafe"],
  ["ChIJuTyah88DbjQRnTzSrugnKs8","Delicatesse 洲際烘焙坊",["bakery","coffee_shop","cafe","pastry_shop","cake_shop","dessert_shop","confectionery","wholesaler","manufacturer","food_store","dessert_restaurant","store","restaurant","food","point_of_interest","service","establishment"],"food",113.8,1.5471591338224235,["early","middle","late"],"cafe"],
  ["ChIJUxqWpocEbjQRIUwU_iCWP4w","高雄中央公園",["city_park","tourist_attraction","park","point_of_interest","establishment"],"open_space",97,1.4585696119718035e-12,["early","middle","late"],null],
  ["ChIJ8Yr7r9QFbjQRSpYsoWeMPUo","中央公園滑草場",["playground","point_of_interest","establishment"],"main_activity",94.3,0.07538183263769044,["early","middle","late"],null],
  ["ChIJa6KZZRkFbjQRRLV3xgh-zG4","愛河灣",["tourist_attraction","point_of_interest","establishment"],"main_activity",94.2,1.3019441763593997,["early","middle","late"],null],
  ["ChIJb7thMX8EbjQRE9FsiIZH9vE","光榮碼頭",["tourist_attraction","point_of_interest","establishment"],"main_activity",93.2,1.260586623974784,["early","middle","late"],null],
  ["ChIJKTktNo4EbjQRoRKMt38KIUY","光之穹頂",["tourist_attraction","scenic_spot","point_of_interest","establishment"],"main_activity",92.9,0.7264328124587123,["early","middle","late"],null],
  ["ChIJ6RxSfH0EbjQRFGeK2utk8Q4","城市光廊",["tourist_attraction","point_of_interest","establishment"],"main_activity",91.3,0.2265002291943106,["early","middle","late"],null],
  ["ChIJ3do1r3sEbjQRVr1ZpRwVrpQ","愛河",["tourist_attraction","scenic_spot","park","point_of_interest","establishment"],"open_space",89.8,1.2079822216982457,["early","middle","late"],null],
  ["ChIJly3pNogDbjQR2wMsjRKBQFA","駁二塔",["tourist_attraction","point_of_interest","establishment"],"main_activity",88,1.9529637392530415,["early","middle","late"],null],
  ["ChIJhywNqsMFbjQRQRq6qpXiYDQ","Furu Cafe",["coffee_shop","cafe","dessert_shop","confectionery","food_store","store","food","point_of_interest","establishment"],"food",114.3,0.6368982380557919,["middle","late"],"cafe"],
  ["ChIJpU9oMiwFbjQR0pRLBBtFv2Y","夯漫廚房",["bistro","coffee_shop","cafe","italian_restaurant","european_restaurant","food_store","store","restaurant","food","point_of_interest","establishment"],"food",110.9,0.7768673452350943,["early","middle","late"],"cafe"],
  ["ChIJKcnoVXAFbjQRGsXLEj-Me78","晴。晨甜點咖啡",["dessert_shop","confectionery","food_store","store","food","point_of_interest","establishment"],"food",110.8,1.1968280467830008,["middle","late"],"cafe"],
  ["ChIJUTnlZxcFbjQRSSNqQAr0X9Y","阡陌一舍",["cafe","cake_shop","bakery","dessert_shop","confectionery","wholesaler","manufacturer","food_store","store","food","point_of_interest","service","establishment"],"food",110.8,2.008809099098595,["early","middle","late"],null],
  ["ChIJq6qqqmUDbjQR4vm-YC7Q7QA","莓塔咖啡館 新崛江店",["restaurant","italian_restaurant","european_restaurant","food_store","store","food","point_of_interest","establishment"],"food",110.5,0.5836176065305771,["early","middle","late"],"cafe"],
  ["ChIJdfvRg4UFbjQRUkFOZNwXbEs","小倉廚（甜點、咖啡）",["dessert_shop","confectionery","food_store","store","food","point_of_interest","establishment"],"food",110.1,1.1658408680029348,["late"],"cafe"],
  ["ChIJt95yQMMFbjQRCtcTvmT-cTM","GOBBLE BLACK · Café & Dessert",["cafe","pastry_shop","cake_shop","bakery","dessert_shop","confectionery","coffee_stand","wholesaler","manufacturer","food_store","dessert_restaurant","store","restaurant","food","point_of_interest","service","establishment"],"food",107.8,0.8399125552850302,["late"],null],
  ["ChIJm9S0KpIEbjQRUB580dLVTE8","樺坊正宗內蒙古特色餐廳",["chinese_restaurant","restaurant","food","point_of_interest","establishment"],"food",94.9,1.4832384935959744,["early","middle","late"],"restaurant"],
  ["ChIJW6_e86gFbjQRIlOnhN6yHtQ","大城老船麵 大立旗艦店",["thai_restaurant","asian_restaurant","food_court","restaurant","food","point_of_interest","establishment"],"food",94.6,0.44601380472798396,["early","middle"],"restaurant"],
  ["ChIJjWLL14YEbjQRMKi6D9KFx4s","Sayang南洋茶室",["restaurant","food","point_of_interest","establishment"],"food",94.4,0.9976040957065397,["early","middle","late"],"restaurant"],
  ["ChIJd9hZ65cFbjQRCT6BeOPcKGc","HATA 烏克蘭廚房",["ukrainian_restaurant","eastern_european_restaurant","european_restaurant","restaurant","food","point_of_interest","establishment"],"food",91.6,1.6948703500992282,["early","middle","late"],"restaurant"],
  ["ChIJQ4merYoDbjQRTB7LRT8m-Kg","好市集手作料理餐廳",["brunch_restaurant","french_restaurant","european_restaurant","restaurant","food","point_of_interest","establishment"],"food",85.4,2.7383029914890034,["early","middle"],"restaurant"],
  ["ChIJfQJ-NAsEbjQRiUmSi7LapjE","壽山觀景台",["observation_deck","landmark","tourist_attraction","point_of_interest","establishment"],"open_space",86,2.7462051205528506,["early","middle","late"],null],
  ["ChIJAwuIKu8DbjQRPuPzfKIupgw","迪卡儂 高雄 亞灣店",["sporting_goods_store","store","point_of_interest","establishment"],"main_activity",85.6,3.1594255047037856,["early","middle","late"],null],
  ["ChIJ429jovcEbjQRYWrkAD4s_ik","安邦休閒公園",["park","tourist_attraction","point_of_interest","establishment"],"open_space",83.5,2.4696839793620704,["early","middle","late"],null],
  ["ChIJifn-9_ADbjQRTR2Q9DmlzEo","高雄燈塔",["tourist_attraction","historical_landmark","historical_place","point_of_interest","establishment"],"main_activity",82.9,3.8203637457011284,["early","middle","late"],null],
  ["ChIJww7mV3QEbjQRC-VewQL1k_o","鐵道園區天空雲台",["observation_deck","tourist_attraction","point_of_interest","establishment"],"main_activity",82.5,2.425898054078612,["early","middle","late"],null],
  ["ChIJ0YxOLAAFbjQRORlbz2O3-e0","凹子底森林公園",["city_park","tourist_attraction","park","point_of_interest","establishment"],"open_space",81.7,3.819009634564364,["early","middle","late"],null],
  ["ChIJv0ZlwHMDbjQRTwlIRH393hs","高雄時空之城",["tourist_attraction","point_of_interest","establishment"],"main_activity",81.4,3.007581212435814,["early","middle","late"],null],
  ["ChIJTc5MKfEDbjQRQ7UUWqpeQhA","雄鎮北門",["historical_landmark","tourist_attraction","historical_place","point_of_interest","establishment"],"main_activity",81.3,3.626853031649724,["early","middle","late"],null],
  ["ChIJWSxbrYoDbjQRqKW-W4bCuHQ","新濱老街",["tourist_attraction","historical_landmark","historical_place","point_of_interest","establishment"],"main_activity",81.2,2.751991875364572,["early","middle","late"],null],
  ["ChIJtcjy-PsEbjQRmkpazggrFXM","愛河之心",["tourist_attraction","park","point_of_interest","establishment"],"open_space",81,3.0980755019528017,["early","middle","late"],null],
  ["ChIJ6zA69LIEbjQRwgBjwyJQ3xc","衛武營都會公園",["city_park","tourist_attraction","park","point_of_interest","establishment"],"open_space",80.7,4.074448543845953,["early","middle","late"],null],
  ["ChIJx1kAdfoEbjQRvtmCcpFBW0Q","三民公園",["park","tourist_attraction","point_of_interest","establishment"],"open_space",80.1,2.4243029523378965,["early","middle","late"],null],
  ["ChIJay59ifEDbjQRld7ipbyyH-4","旗津老街",["tourist_attraction","historical_landmark","historical_place","point_of_interest","establishment"],"main_activity",79.2,3.551988451510126,["early","middle","late"],null],
  ["ChIJPc78y1cEbjQRk3pDBcU8kG4","光之塔",["tourist_attraction","point_of_interest","establishment"],"main_activity",77.8,2.998910623482997,["early","middle","late"],null],
  ["ChIJ_ZFmYEUEbjQRKUE4KD5woDM","青海公園",["park","point_of_interest","establishment"],"open_space",77.3,3.4275279753393235,["early","middle","late"],null],
  ["ChIJebYXpRsFbjQRMDYybJC98OQ","河堤公園",["park","point_of_interest","establishment"],"open_space",75.7,4.725442758272295,["early","middle","late"],null],
]

export const capturedLinks = {
  "culture_primary": [],
  "coffee_venue": [
    "ChIJH84gKYgEbjQRm8xsvOZ5rKM",
    "ChIJuTyah88DbjQRnTzSrugnKs8",
    "ChIJhywNqsMFbjQRQRq6qpXiYDQ"
  ],
  "mixed_or_uncertain": [
    "ChIJKcnoVXAFbjQRGsXLEj-Me78",
    "ChIJq6qqqmUDbjQR4vm-YC7Q7QA",
    "ChIJdfvRg4UFbjQRUkFOZNwXbEs"
  ]
}
export const capturedPromptLengths = [
  {
    "stage": "initial",
    "characters": 17341,
    "utf8Bytes": 23601
  },
  {
    "stage": "retry",
    "characters": 17521,
    "utf8Bytes": 24153
  }
]

export function capturedCultureProjectionPool() {
  const candidates = rows.map(([placeId, name, types, role, score, distanceKm, availabilitySlots, foodSubtype]) => ({
    placeId, name, types: [...types], role, score, distanceKm, address: '',
    availabilitySlots: [...availabilitySlots], ...(foodSubtype ? { foodSubtype } : {}),
    // Only the observed eligibility flags are needed by the Prompt selector.
    // Empty windows are a test adapter, never evidence of an actual opening window.
    openingHours: { isKnown: true, isNeverOpen: false, windows: [] },
  }))
  // Saved first-stop count is 10; the captured ordering is near, food, then activity.
  return { allCandidates: candidates, firstStopCandidates: candidates.slice(0, 10),
    otherCandidates: candidates.slice(10) }
}
