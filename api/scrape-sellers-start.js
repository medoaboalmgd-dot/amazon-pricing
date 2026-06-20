export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { asins, amazon_domain } = req.body
  const token = (process.env.APIFY_TOKEN || process.env.VITE_APIFY_TOKEN)

  const input = {
    amazon_domain: amazon_domain || 'www.amazon.eg',
    asins: asins || [],
    first_ten_sellers: false,
    get_amazon: true,
    use_apify_dataset: true,
  }

  try {
    const response = await fetch(`https://api.apify.com/v2/acts/saswave~amazon-seller-monitoring/runs?token=${token}&maxTotalChargeUsd=50`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    const data = await response.json()
    res.status(200).json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
