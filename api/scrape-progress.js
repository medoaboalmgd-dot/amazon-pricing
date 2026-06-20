export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const { runId } = req.query
  const token = (process.env.APIFY_TOKEN || process.env.VITE_APIFY_TOKEN)

  try {
    // Get run info
    const runRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`)
    const runData = await runRes.json()
    const status = runData.data?.status
    const datasetId = runData.data?.defaultDatasetId

    // Get real item count from dataset
    let itemCount = 0
    if (datasetId) {
      try {
        const dsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}?token=${token}`)
        const dsData = await dsRes.json()
        itemCount = dsData.data?.itemCount || 0
      } catch { /* ignore */ }
    }

    res.status(200).json({ status, itemCount })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
