export async function runScrapeAE(searchUrl, maxPages = 3) {
  const res = await fetch('/api/scrape-start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ search_url: searchUrl, max_pages: maxPages }),
  })
  const data = await res.json()
  return data.data?.id
}

export async function runScrapeEG(asins) {
  const res = await fetch('/api/scrape-start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      asins,
      amazon_domain: 'www.amazon.eg',
      max_pages: 1,
    }),
  })
  const data = await res.json()
  return data.data?.id
}

export async function runScrapeSellers(asins, amazon_domain = 'www.amazon.eg') {
  const res = await fetch('/api/scrape-sellers-start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ asins, amazon_domain }),
  })
  const data = await res.json()
  return data.data?.id
}

export async function getRunStatus(runId) {
  const res = await fetch(`/api/scrape-status?runId=${runId}`)
  const data = await res.json()
  return data.data?.status
}

export async function getRunResults(runId) {
  const res = await fetch(`/api/scrape-results?runId=${runId}`)
  return await res.json()
}
