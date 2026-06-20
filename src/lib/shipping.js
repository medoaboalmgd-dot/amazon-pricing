// Calculate EGP shipping fee from weight and dimensions
export function calculateShipping(actualWeight, length = null, width = null, height = null,
                                   divisor = 5000, safetyMargin = 0.05, minimumCharge = 200, roundTo = 10) {
  const dimsMissing = !(length && width && height)
  const volumetric = dimsMissing ? 0 : (length * width * height) / divisor
  const chargeable = Math.max(Number(actualWeight) || 0, volumetric)

  // Apply safety margin before choosing the tier
  const billed = chargeable * (1 + safetyMargin)

  let rate
  if (billed < 1) rate = 1000
  else if (billed < 3) rate = 600
  else if (billed < 8) rate = 300
  else rate = 250

  const rawFee = billed * rate

  // Minimum charge, then round UP to nearest multiple
  let fee = Math.max(rawFee, minimumCharge)
  fee = Math.ceil(fee / roundTo) * roundTo

  // Suspicious detection:
  // - volumetric weight is 3x+ the actual weight (likely wrong dimensions)
  // - OR fee > 5000 EGP while actual weight < 5 kg
  const actual = Number(actualWeight) || 0
  const suspicious =
    (!dimsMissing && volumetric > actual * 3 && volumetric > 5) ||
    (fee > 5000 && actual < 5)

  return {
    volumetric_weight: Math.round(volumetric * 1000) / 1000,
    chargeable_weight: Math.round(chargeable * 1000) / 1000,
    billed_weight: Math.round(billed * 1000) / 1000,
    rate,
    raw_fee: Math.round(rawFee),
    shipping_fee: fee,
    dims_missing: dimsMissing,
    suspicious,
  }
}

// Get AI weight/dimensions estimate
export async function estimateWeight(title, asin) {
  const res = await fetch('/api/estimate-weight', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, asin }),
  })
  const data = await res.json()
  return data
}
