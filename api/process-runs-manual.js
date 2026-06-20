// Manual processor: takes run IDs, fetches their datasets, and processes results
// Use this to recover from runs that completed in Apify but webhook didn't fire
// Usage: GET /api/process-runs-manual?market=ae&runs=runId1,runId2
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
const APIFY_TOKEN = process.env.APIFY_TOKEN || process.env.VITE_APIFY_TOKEN
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.VITE_TELEGRAM_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.VITE_TELEGRAM_CHAT_ID
const OUR_SELLER = 'BestQualityBestPrice'
const OUR_SELLER_ID = 'A25ACUE2T1TUS6'

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

function parseDeliveryDays(deliveries) {
  if (!deliveries || !deliveries.length) return null
  const d = deliveries.find(x => x.type === 'fastest') ||
            deliveries.find(x => x.type === 'FREE') ||
            deliveries[0]
  if (!d || !d.date) return null
  const dateStr = d.date
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  if (dateStr.toLowerCase().includes('today')) return 0
  if (dateStr.toLowerCase().includes('tomorrow')) return 1
  const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11,
    january:0, february:1, march:2, april:3, june:5, july:6, august:7, september:8, october:9, november:10, december:11 }
  const match = dateStr.match(/(\d{1,2})\s*(?:-\s*\d{1,2})?\s+([A-Za-z]+)/)
  if (match) {
    const day = parseInt(match[1])
    const month = months[match[2].toLowerCase()]
    if (month !== undefined) {
      const year = today.getFullYear()
      const target = new Date(year, month, day)
      if (target < today) target.setFullYear(year + 1)
      const diff = Math.round((target - today) / 86400000)
      return diff >= 0 ? diff : null
    }
  }
  return null
}

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    })
  } catch (err) { console.error('Telegram error:', err) }
}

async function getRunInfo(runId) {
  const r = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`)
  return await r.json()
}

async function getDatasetItems(datasetId) {
  const r = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&limit=10000`)
  return await r.json()
}

export default async function handler(req, res) {
  const market = req.query.market || 'ae'
  const runsParam = req.query.runs || ''
  const runIds = runsParam.split(',').filter(Boolean)

  if (!runIds.length) {
    return res.status(400).json({
      error: 'Missing ?runs=runId1,runId2',
      usage: '/api/process-runs-manual?market=ae&runs=xxx,yyy',
    })
  }

  try {
    // Get state for context (prev prices etc)
    const { data: state } = await supabase
      .from('scrape_state')
      .select('*')
      .eq('market', market)
      .single()

    if (!state) {
      return res.status(404).json({ error: `No scrape_state for market=${market}` })
    }

    // Fetch all runs in parallel
    const runs = await Promise.all(runIds.map(getRunInfo))
    const allResults = []
    const runStatuses = []

    for (const r of runs) {
      const status = r.data?.status
      const datasetId = r.data?.defaultDatasetId
      runStatuses.push({ id: r.data?.id, status, datasetId })
      if (status === 'SUCCEEDED' && datasetId) {
        const items = await getDatasetItems(datasetId)
        if (Array.isArray(items)) allResults.push(...items)
      }
    }

    if (!allResults.length) {
      return res.status(200).json({
        message: 'No results found in any run',
        runStatuses,
      })
    }

    // Group by asin
    const byAsin = {}
    for (const row of allResults) {
      if (!byAsin[row.asin]) byAsin[row.asin] = []
      byAsin[row.asin].push(row)
    }

    // ===== AE PROCESSING =====
    if (market === 'ae') {
      const prevPrices = state.prev_data?.prevPrices || {}
      const prevDeliveryDays = state.prev_data?.prevDeliveryDays || {}
      const totalProducts = state.prev_data?.totalProducts || 0

      const updates = []
      const histories = []
      const alerts = []

      for (const [asin, sellers] of Object.entries(byAsin)) {
        const buyBoxRow = sellers.find(s => s.buy_box) || sellers[0]
        const priceStr = buyBoxRow?.price?.toString().replace(/,/g, '')
        const newPrice = priceStr ? parseFloat(priceStr) : null
        const deliveryDays = parseDeliveryDays(buyBoxRow?.deliveries)
        const deliveryDate = buyBoxRow?.deliveries?.[0]?.date || null
        const available = !!buyBoxRow

        updates.push({
          asin, price_aed: newPrice, delivery_days_ae: deliveryDays,
          delivery_date_ae: deliveryDate, last_scraped_ae: new Date().toISOString(),
        })
        histories.push({
          asin, price_aed: newPrice,
          buy_box_seller: buyBoxRow?.seller_name || null, source: 'ae_update',
        })

        const prev = prevPrices[asin]
        const prevDays = prevDeliveryDays[asin]
        if (!available) {
          alerts.push({ asin, alert_type: 'unavailable_ae', old_value: prev, new_value: null })
        } else if (newPrice && prev && newPrice > prev) {
          alerts.push({ asin, alert_type: 'price_up', old_value: prev, new_value: newPrice })
        } else if (newPrice && prev && newPrice < prev) {
          alerts.push({ asin, alert_type: 'price_down', old_value: prev, new_value: newPrice })
        }
        if (deliveryDays != null && prevDays != null && Math.abs(deliveryDays - prevDays) > 2) {
          alerts.push({ asin, alert_type: 'delivery_change', old_value: prevDays, new_value: deliveryDays })
        }
      }

      // Save in parallel
      const tasks = []
      for (const u of updates) {
        tasks.push(supabase.from('products').update({
          price_aed: u.price_aed, delivery_days_ae: u.delivery_days_ae,
          delivery_date_ae: u.delivery_date_ae, last_scraped_ae: u.last_scraped_ae,
        }).eq('asin', u.asin))
      }
      if (histories.length) tasks.push(supabase.from('price_history').insert(histories))
      if (alerts.length) tasks.push(supabase.from('price_alerts').insert(alerts))
      await Promise.all(tasks)

      // FAIL-SAFE
      const minExpected = Math.max(10, Math.floor(totalProducts * 0.3))
      if (updates.length < minExpected) {
        await sendTelegram(`⚠️ معالجة يدوية: ${updates.length}/${totalProducts} فقط — الحماية مفعلة`)
      } else {
        const priceUps = alerts.filter(a => a.alert_type === 'price_up')
        const priceDowns = alerts.filter(a => a.alert_type === 'price_down')
        const unavailable = alerts.filter(a => a.alert_type === 'unavailable_ae')
        const deliveryChanges = alerts.filter(a => a.alert_type === 'delivery_change')

        let msg = `🤖 تحديث AE (معالجة يدوية)\n━━━━━━━━━━━━━━━\n`
        msg += `✅ تم تحديث ${updates.length}/${totalProducts} منتج\n\n`

        if (priceUps.length) {
          msg += `📈 سعر AE ارتفع (${priceUps.length}):\n`
          for (const a of priceUps.slice(0, 15)) {
            const pct = (((Number(a.new_value) - Number(a.old_value)) / Number(a.old_value)) * 100).toFixed(1)
            msg += `• ${a.asin}: ${a.old_value} ← ${a.new_value} AED (+${pct}%)\n`
          }
          if (priceUps.length > 15) msg += `  ...+${priceUps.length - 15} أكتر\n`
          msg += `\n`
        }
        if (priceDowns.length) {
          msg += `📉 سعر AE نزل (${priceDowns.length}):\n`
          for (const a of priceDowns.slice(0, 15)) {
            const pct = (((Number(a.new_value) - Number(a.old_value)) / Number(a.old_value)) * 100).toFixed(1)
            msg += `• ${a.asin}: ${a.old_value} ← ${a.new_value} AED (${pct}%)\n`
          }
          if (priceDowns.length > 15) msg += `  ...+${priceDowns.length - 15} أكتر\n`
          msg += `\n`
        }
        if (deliveryChanges.length) {
          msg += `🚚 فترة التوصيل اتغيرت (${deliveryChanges.length}):\n`
          for (const a of deliveryChanges.slice(0, 15)) {
            const diff = Number(a.new_value) - Number(a.old_value)
            msg += `• ${a.asin}: ${a.old_value}يوم ← ${a.new_value}يوم (${diff > 0 ? '+' : ''}${diff})\n`
          }
          if (deliveryChanges.length > 15) msg += `  ...+${deliveryChanges.length - 15} أكتر\n`
          msg += `\n`
        }
        if (unavailable.length) {
          msg += `🔴 مش موجود في الإمارات (${unavailable.length}):\n`
          for (const a of unavailable.slice(0, 20)) msg += `• ${a.asin}\n`
          if (unavailable.length > 20) msg += `  ...+${unavailable.length - 20} أكتر\n`
          msg += `\n`
        }
        if (alerts.length === 0) msg += `✨ مفيش أي تنبيهات`
        else msg += `━━━━━━━━━━━━━━━\n🔔 إجمالي التنبيهات: ${alerts.length}`

        await sendTelegram(msg)
      }

      await supabase.from('scrape_state').update({
        completed_batches: state.total_batches,
        products_updated: updates.length,
        completed_at: new Date().toISOString(),
      }).eq('market', market)

      return res.status(200).json({
        success: true,
        runStatuses,
        updates: updates.length,
        alerts: alerts.length,
      })
    }

    // ===== EG PROCESSING =====
    if (market === 'eg') {
      const prevListedAsins = state.prev_data?.prevListedAsins || []
      const totalProducts = state.prev_data?.totalProducts || 0
      const prevListedSet = new Set(prevListedAsins)

      let processedCount = 0
      const alerts = []
      const histories = []

      for (const [asin, sellers] of Object.entries(byAsin)) {
        const buyBox = sellers.find(s => s.buy_box)
        const us = sellers.find(s => s.seller_name === OUR_SELLER || s.seller === OUR_SELLER_ID)
        const buyBoxPrice = buyBox?.price ? parseFloat(String(buyBox.price).replace(/,/g, '')) : null
        const ourPrice = us?.price ? parseFloat(String(us.price).replace(/,/g, '')) : null

        await supabase.from('product_sellers').delete().eq('asin', asin)
        const sellerRows = sellers.map(s => ({
          asin, seller_id: s.seller || null, seller_name: s.seller_name || null,
          price_egp: s.price ? parseFloat(String(s.price).replace(/,/g, '')) : null,
          position: s.position || null, is_buy_box: !!s.buy_box,
          is_us: s.seller_name === OUR_SELLER || s.seller === OUR_SELLER_ID,
          rating_text: s.reviews?.[0] || null, rating_count: s.reviews?.[1] || null,
          positive_pct: s.reviews?.[2] || null, delivery_date: s.deliveries?.[0]?.date || null,
          asin_total_sellers: s.asin_total_sellers || sellers.length,
        }))
        if (sellerRows.length) await supabase.from('product_sellers').insert(sellerRows)

        await supabase.from('product_eg_data').upsert({
          asin, price_egp: buyBoxPrice,
          buy_box_seller: buyBox?.seller_name || null,
          buy_box_seller_id: buyBox?.seller || null,
          buy_box_position: buyBox?.position || null,
          total_sellers: sellers[0]?.asin_total_sellers || sellers.length,
          our_position: us?.position || null, our_price_egp: ourPrice,
          is_our_listing: !!(us && us.buy_box),
          last_scraped_eg: new Date().toISOString(),
        }, { onConflict: 'asin' })

        if (us) await supabase.from('products').update({ awaiting_listing: false }).eq('asin', asin)

        histories.push({
          asin, price_egp: buyBoxPrice,
          buy_box_seller: buyBox?.seller_name || null,
          our_price_egp: ourPrice, source: 'eg_update',
        })
        if (prevListedSet.has(asin) && !us) {
          alerts.push({ asin, alert_type: 'delisted', old_value: null, new_value: null })
        }
        processedCount++
      }

      if (histories.length) await supabase.from('price_history').insert(histories)
      if (alerts.length) await supabase.from('price_alerts').insert(alerts)

      const minExpected = Math.max(10, Math.floor(totalProducts * 0.3))
      if (processedCount < minExpected) {
        await sendTelegram(`⚠️ معالجة EG يدوية: ${processedCount}/${totalProducts} — الحماية مفعلة`)
      } else {
        let msg = `🤖 تحديث EG (معالجة يدوية)\n━━━━━━━━━━━━━━━\n`
        msg += `✅ تم تحديث ${processedCount}/${totalProducts} منتج\n\n`
        if (alerts.length) {
          msg += `🟠 مبقاش معروض في مصر (${alerts.length}):\n`
          for (const a of alerts.slice(0, 20)) msg += `• ${a.asin}\n`
          if (alerts.length > 20) msg += `  ...+${alerts.length - 20} أكتر\n\n`
          else msg += `\n`
          msg += `━━━━━━━━━━━━━━━\n🔔 إجمالي التنبيهات: ${alerts.length}`
        } else {
          msg += `✨ مفيش أي تنبيهات`
        }
        await sendTelegram(msg)
      }

      await supabase.from('scrape_state').update({
        completed_batches: state.total_batches,
        products_updated: processedCount,
        completed_at: new Date().toISOString(),
      }).eq('market', market)

      return res.status(200).json({
        success: true, runStatuses, processed: processedCount, alerts: alerts.length,
      })
    }

    return res.status(400).json({ error: `Unknown market: ${market}` })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

export const config = { maxDuration: 300 }
