export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { asins } = req.body
  const token = (process.env.APIFY_TOKEN || process.env.VITE_APIFY_TOKEN)
  if (!asins || !asins.length) return res.status(200).json({ results: [] })

  try {
    // Use product scraper on amazon.eg — products not in catalog won't appear in results
    const runRes = await fetch(
      `https://api.apify.com/v2/acts/saswave~amazon-product-scraper/runs?token=${token}&maxTotalChargeUsd=10`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asins,
          amazon_domain: 'www.amazon.eg',
          max_pages: 1,
        }),
      }
    )
    const runData = await runRes.json()
    const runId = runData.data?.id
    const datasetId = runData.data?.defaultDatasetId
    if (!runId) return res.status(200).json({ results: asins.map(a => ({ asin: a, in_catalog: null })) })

    // Poll until done (max 90s)
    let status = 'RUNNING'
    let waited = 0
    while (status === 'RUNNING' && waited < 90000) {
      await new Promise(r => setTimeout(r, 4000))
      waited += 4000
      const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`)
      const statusData = await statusRes.json()
      status = statusData.data?.status
    }

    // Get results
    const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&limit=1000`)
    const items = await itemsRes.json()

    // Build map: asin -> in_catalog
    // A product is in catalog if it has a non-empty title or availability=true
    // (Empty title + availability=false means scraper found the page but it was empty/404)
    const itemsArr = Array.isArray(items) ? items : []
    const productMap = new Map()
    for (const item of itemsArr) {
      if (item.asin) {
        const inCatalog = !!(item.title || item.availability || (item.images && item.images.length))
        productMap.set(item.asin, inCatalog)
      }
    }

    const results = asins.map(asin => ({
      asin,
      in_catalog: status === 'SUCCEEDED' ? (productMap.has(asin) ? productMap.get(asin) : false) : null,
    }))

    res.status(200).json({ results })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
