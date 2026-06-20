import * as XLSX from 'xlsx'

// Round price to nearest 49 or 99 (up or down, whichever is closest)
export function roundPrice(price) {
  if (!price) return price
  const base = Math.floor(price / 100) * 100
  const candidates = [base - 51, base - 1, base + 49, base + 99, base + 149]
  return candidates.reduce((best, c) =>
    Math.abs(c - price) < Math.abs(best - price) ? c : best
  )
}

// Parse shipping Excel - supports with or without headers
export function parseShippingExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '', header: 1 })
        const result = []

        for (const row of rows) {
          if (!row || row.length < 2) continue
          let asin = null, shipping = null

          // Check if first row is header
          const firstVal = String(row[0]).trim().toLowerCase()
          if (firstVal === 'asin' || firstVal === 'shipping' || firstVal === 'شحن') continue

          // Try to find ASIN and shipping in row
          for (let i = 0; i < row.length; i++) {
            const val = String(row[i]).trim()
            if (/^B[A-Z0-9]{9}$/i.test(val)) {
              asin = val
            } else if (!isNaN(parseFloat(val)) && parseFloat(val) > 0) {
              shipping = parseFloat(val)
            }
          }

          if (asin && shipping) result.push({ asin, shipping_egp: shipping })
        }
        resolve(result)
      } catch (err) { reject(err) }
    }
    reader.onerror = reject
    reader.readAsArrayBuffer(file)
  })
}

// Fill Amazon template via Python serverless function (preserves macros/formatting)
export function fillAmazonTemplate(file, products, onNotInCatalog) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = async (e) => {
      try {
        const base64 = e.target.result.split(',')[1]
        const productMap = {}
        products.forEach(p => {
          productMap[p.asin] = {
            min: roundPrice(p.min_price_egp),
            max: roundPrice(p.max_price_egp),
          }
        })

        const res = await fetch('/api/fill-template', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: base64, products: productMap }),
        })
        if (!res.ok) {
          const err = await res.json()
          throw new Error(err.error || 'فشل ملء التمبلت')
        }
        const data = await res.json()

        // Handle not in catalog
        if (data.not_in_catalog?.length && onNotInCatalog) {
          await onNotInCatalog(data.not_in_catalog)
        }

        const bytes = Uint8Array.from(atob(data.file), c => c.charCodeAt(0))
        resolve({
          blob: new Blob([bytes], { type: 'application/vnd.ms-excel.sheet.macroenabled.12' }),
          filledAsins: data.filled_asins || [],
          notInCatalog: data.not_in_catalog || [],
        })
      } catch (err) { reject(err) }
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// Export ASINs only
export function exportAsins(products) {
  const rows = products.map(p => ({ ASIN: p.asin, Title: p.title }))
  const ws = XLSX.utils.json_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'ASINs')
  XLSX.writeFile(wb, `asins_${new Date().toISOString().slice(0,10)}.xlsx`)
}

const ERROR_MESSAGES = {
  '18299': 'محتاج موافقة للبراند',
  '5886': 'ASIN محمي - Generic Policy',
  '13013': 'المنتج مش في الكاتالوج',
  '18555': 'السعر أعلى من الحد المسموح',
  '5461': 'مش مسموح بإضافة ASIN للبراند ده',
  '18503': 'محتاج موافقة لبيع المنتج ده',
  '90244': 'قيمة field غير مقبولة',
  '100339': 'HTML في الوصف',
  '99022': 'حقل مطلوب ناقص',
}

// Parse processing summary + original template to get ASIN → error mapping
export function parseProcessingSummary(summaryFile, templateFile) {
  return new Promise((resolve, reject) => {
    const readFile = (file) => new Promise((res, rej) => {
      const reader = new FileReader()
      reader.onload = e => res(e.target.result)
      reader.onerror = rej
      reader.readAsArrayBuffer(file)
    })

    Promise.all([readFile(summaryFile), readFile(templateFile)]).then(([summaryBuf, templateBuf]) => {
      try {
        // Read summary sheet
        const swb = XLSX.read(summaryBuf, { type: 'array' })
        const sws = swb.Sheets['Feed Processing Summary']
        if (!sws) throw new Error('مفيش شيت "Feed Processing Summary"')

        const summaryRows = XLSX.utils.sheet_to_json(sws, { header: 1, defval: '' })

        // Find "Errors and Warnings per SKU" section
        let skuSectionStart = -1
        for (let i = 0; i < summaryRows.length; i++) {
          if (summaryRows[i].some(v => String(v).includes('Errors and Warnings per SKU'))) {
            skuSectionStart = i + 2 // skip header row
            break
          }
        }

        // Build SKU → errors map
        const skuErrors = {}
        if (skuSectionStart > 0) {
          for (let i = skuSectionStart; i < summaryRows.length; i++) {
            const row = summaryRows[i]
            const errorCode = String(row[2] || '').trim()
            const sku = String(row[6] || '').trim()
            if (!sku || !errorCode) continue
            if (!skuErrors[sku]) skuErrors[sku] = []
            skuErrors[sku].push(errorCode)
          }
        }

        // Read template: build SKU → ASIN map
        const twb2 = XLSX.read(templateBuf, { type: 'array' })
        const tws = twb2.Sheets['Template']
        if (!tws) throw new Error('مفيش شيت "Template"')

        const templateRows = XLSX.utils.sheet_to_json(tws, { header: 1, defval: '' })

        // Find attribute row (has contribution_sku)
        let attrRowIdx = -1
        let skuColIdx = -1
        let asinColIdx = -1
        for (let i = 0; i < 10; i++) {
          const row = templateRows[i] || []
          for (let j = 0; j < row.length; j++) {
            if (String(row[j]).includes('contribution_sku')) { skuColIdx = j; attrRowIdx = i }
            if (String(row[j]).includes('merchant_suggested_asin')) asinColIdx = j
          }
          if (attrRowIdx >= 0) break
        }

        // Build SKU → ASIN map from template
        const skuToAsin = {}
        const dataStart = attrRowIdx + 2
        for (let i = dataStart; i < templateRows.length; i++) {
          const row = templateRows[i] || []
          const sku = String(row[skuColIdx] || '').trim()
          const asin = String(row[asinColIdx] || '').trim()
          if (sku && asin && asin.startsWith('B')) {
            skuToAsin[sku] = asin
          }
        }

        // Build result: asin → {errors, needs_price_fix, reason}
        const result = []
        const processedAsins = new Set()

        for (const [sku, errors] of Object.entries(skuErrors)) {
          const asin = skuToAsin[sku]
          if (!asin || processedAsins.has(asin)) continue
          processedAsins.add(asin)

          const needsPriceFix = errors.includes('18555')
          const onlyPriceFix = errors.every(e => e === '18555')

          // Get most important error message
          const reasons = [...new Set(errors.map(e => ERROR_MESSAGES[e] || `خطأ ${e}`))]
          const reason = reasons.join(' | ')

          result.push({ asin, reason, needs_price_fix: needsPriceFix && onlyPriceFix })
        }

        resolve(result)
      } catch (err) { reject(err) }
    }).catch(reject)
  })
}

// Parse Excel file with ASINs (single column or first column)
// Skips header row if first cell isn't a valid ASIN
// Returns deduplicated array of valid ASINs
export function parseAsinsExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const workbook = XLSX.read(e.target.result, { type: 'binary' })
        const sheet = workbook.Sheets[workbook.SheetNames[0]]
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })

        const ASIN_REGEX = /^B[A-Z0-9]{9}$/i
        const asins = new Set()

        for (const row of rows) {
          // Check all cells in the row (in case ASIN isn't in first column)
          for (const cell of row) {
            const val = String(cell || '').trim().toUpperCase()
            if (ASIN_REGEX.test(val)) {
              asins.add(val)
              break // one ASIN per row
            }
          }
        }

        resolve([...asins])
      } catch (err) {
        reject(err)
      }
    }
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsBinaryString(file)
  })
}
