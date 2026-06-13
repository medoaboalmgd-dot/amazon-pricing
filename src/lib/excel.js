import * as XLSX from 'xlsx'

// Parse Excel file with ASIN + shipping columns
// Expected columns: ASIN, Shipping (any order, case-insensitive)
export function parseShippingExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' })

        const result = []
        for (const row of rows) {
          const keys = Object.keys(row).map(k => k.toLowerCase())
          const asinKey = Object.keys(row).find(k => k.toLowerCase().includes('asin'))
          const shipKey = Object.keys(row).find(k =>
            k.toLowerCase().includes('ship') || k.toLowerCase().includes('شحن')
          )
          if (!asinKey || !shipKey) continue
          const asin = String(row[asinKey]).trim()
          const shipping = parseFloat(row[shipKey])
          if (asin && !isNaN(shipping)) {
            result.push({ asin, shipping_egp: shipping })
          }
        }
        resolve(result)
      } catch (err) {
        reject(err)
      }
    }
    reader.onerror = reject
    reader.readAsArrayBuffer(file)
  })
}

// Export Amazon listing template
export function exportAmazonTemplate(products) {
  const rows = products.map(p => ({
    'Your Search Term': p.asin,
    'Recommended Action': 'Ready to List',
    "Amazon's Title": p.title,
    '::record_action': 'Add Product',
    'contribution_sku#1.value': p.asin,
    'merchant_suggested_asin#1.value': p.asin,
    'condition_type#1.value': 'New',
    'fulfillment_availability#1.fulfillment_channel_code': 'DEFAULT',
    'fulfillment_availability#1.quantity': 10,
    'purchasable_offer[marketplace_id=ARBP9OOSHTCHU][audience=ALL]#1.our_price#1.schedule#1.value_with_tax': p.max_price_egp,
    'purchasable_offer[marketplace_id=ARBP9OOSHTCHU][audience=ALL]#1.automated_pricing_merchandising_rule_plan#1.merchandising_rule.rule_id': 'Competitive Price Rule by Amazon',
    'purchasable_offer[marketplace_id=ARBP9OOSHTCHU][audience=ALL]#1.minimum_seller_allowed_price#1.schedule#1.value_with_tax': p.min_price_egp,
    'purchasable_offer[marketplace_id=ARBP9OOSHTCHU][audience=ALL]#1.maximum_seller_allowed_price#1.schedule#1.value_with_tax': p.max_price_egp,
  }))

  const ws = XLSX.utils.json_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Template')
  XLSX.writeFile(wb, `amazon_listing_${new Date().toISOString().slice(0,10)}.xlsx`)
}

// Export ASINs only
export function exportAsins(products) {
  const rows = products.map(p => ({ ASIN: p.asin, Title: p.title }))
  const ws = XLSX.utils.json_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'ASINs')
  XLSX.writeFile(wb, `asins_${new Date().toISOString().slice(0,10)}.xlsx`)
}
