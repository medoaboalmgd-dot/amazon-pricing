const APIFY_TOKEN = 'apify_api_3gEv1Dm8UOptd8Jogec1X4iuhIi1tf0Zfx1w'
const ACTOR_ID = 'saswave/amazon-product-scraper'
const BASE_URL = 'https://api.apify.com/v2'

export async function runScrapeAE(searchUrl, maxPages = 3) {
  const res = await fetch(`${BASE_URL}/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      search_url: searchUrl,
      max_pages: maxPages,
    }),
  })
  const data = await res.json()
  return data.data?.id
}

export async function runScrapeEG(asins) {
  const urls = asins.map(asin => `https://www.amazon.eg/dp/${asin}`)
  const res = await fetch(`${BASE_URL}/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      search_url: urls[0],
      max_pages: 1,
      asins: asins,
    }),
  })
  const data = await res.json()
  return data.data?.id
}

export async function getRunStatus(runId) {
  const res = await fetch(`${BASE_URL}/actor-runs/${runId}?token=${APIFY_TOKEN}`)
  const data = await res.json()
  return data.data?.status // RUNNING | SUCCEEDED | FAILED
}

export async function getRunResults(runId) {
  const res = await fetch(`${BASE_URL}/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}&clean=true`)
  return await res.json()
}
