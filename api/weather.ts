
type VercelRequest = {
  method?: string
  query?: {
    location?: string
  }
}

type VercelResponse = {
  status: (code: number) => VercelResponse
  json: (body: unknown) => void
}

type CwaResponse = {
  success?: string
  records?: {
    location?: Array<{
      locationName: string
      weatherElement: Array<{
        elementName: string
        time: Array<{
          startTime: string
          endTime: string
          parameter?: {
            parameterName?: string
          }
          elementValue?: Array<{
            value?: string
          }>
        }>
      }>
    }>
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const location = req.query?.location?.trim()

  if (!location) {
    res.status(400).json({ error: '請提供旅遊目的地，例如高雄市' })
    return
  }

  const apiKey = process.env.CWA_API_KEY

  if (!apiKey) {
    res.status(500).json({ error: 'CWA_API_KEY 尚未設定' })
    return
  }

  try {
    const params = new URLSearchParams({
      Authorization: apiKey,
      locationName: location,
    })

    const url =
      'https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-C0032-001?' +
      params.toString()

    const response = await fetch(url)

    if (!response.ok) {
      console.error('CWA HTTP status:', response.status)
      res.status(502).json({ error: '中央氣象署服務暫時無法使用' })
      return
    }

    const data = (await response.json()) as CwaResponse
    const place = data.records?.location?.[0]

    if (data.success !== 'true' || !place) {
      res.status(404).json({
        error: '找不到該地區的預報資料，請確認縣市名稱',
        location,
      })
      return
    }

    const getElement = (name: string) =>
      place.weatherElement.find((item) => item.elementName === name)

    const wx = getElement('Wx')
    const pop = getElement('PoP')
    const minT = getElement('MinT')
    const maxT = getElement('MaxT')
    const ci = getElement('CI')

    const forecasts = (wx?.time ?? []).map((period, index) => ({
      startTime: period.startTime,
      endTime: period.endTime,
      weather: period.parameter?.parameterName ?? '',
      rainProbability:
        pop?.time[index]?.elementValue?.[0]?.value ?? '',
      minTemperature:
        minT?.time[index]?.elementValue?.[0]?.value ?? '',
      maxTemperature:
        maxT?.time[index]?.elementValue?.[0]?.value ?? '',
      comfort:
        ci?.time[index]?.parameter?.parameterName ?? '',
    }))

    res.status(200).json({
      location: place.locationName,
      forecasts,
    })
  } catch (error) {
    console.error('Weather API error:', error)
    res.status(500).json({ error: '取得天氣資料時發生錯誤' })
  }
}