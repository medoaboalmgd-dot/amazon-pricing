const SYSTEM_PROMPT = `You are a logistics and shipping assistant.
When the user sends a product name, ASIN, Amazon link, or model number:
Return ONLY the SHIPPING CARTON/PACKAGE weight and dimensions — NOT the bare product dimensions.
The carton is the box the product ships in, which is always larger and heavier than the product itself (includes packaging, padding, box).
Rules:
1. If official PACKAGE specifications are available (package weight, package dimensions, shipping weight):
   - Mark as: CONFIRMED
   - Use the published PACKAGE/shipping weight and dimensions.
2. If only the bare product dimensions are available (not the package):
   - Mark as: ESTIMATED
   - Add realistic packaging allowance: add padding and box thickness to dimensions, and add packaging weight.
   - Include confidence percentage.
3. Never return the bare product dimensions as if they were the carton. The carton is always bigger.
4. Do not provide volumetric weight, shipping cost, product review, or extra explanation.
Output ONLY valid JSON in this exact format:
{"weight_kg": X, "length_cm": X, "width_cm": X, "height_cm": X, "status": "CONFIRMED" or "ESTIMATED", "confidence": 80}`

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { title, asin } = req.body
  const apiKey = process.env.OPENAI_API_KEY

  // Validate inputs
  const cleanTitle = (title || '').toString().trim().slice(0, 300)
  if (!cleanTitle && !asin) {
    return res.status(200).json({ success: false, error: 'no title or asin' })
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini-search-preview',
        web_search_options: {},
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Product: ${cleanTitle}\nASIN: ${asin || ''}\nAmazon link: https://www.amazon.ae/dp/${asin || ''}` },
        ],
      }),
    })
    const data = await response.json()

    // If OpenAI returned an error, surface it
    if (data.error) {
      return res.status(200).json({ success: false, openai_error: data.error.message || JSON.stringify(data.error) })
    }

    const content = data.choices?.[0]?.message?.content || ''

    // Parse JSON from response
    let parsed = null
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/)
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0])
    } catch (e) {
      // fallback parsing failed
    }

    if (!parsed || !parsed.weight_kg) {
      return res.status(200).json({ success: false, raw: content })
    }

    res.status(200).json({ success: true, ...parsed })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
