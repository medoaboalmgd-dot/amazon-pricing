// Apify Webhook: Called when AE scrape run completes
// Processes the dataset and updates DB + sends Telegram
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
const APIFY_TOKEN = process.env.APIFY_TOKEN || process.env.VITE_APIFY_TOKEN
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.VITE_TELEGRAM_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.VITE_TELEGRAM_CHAT_ID
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'amazon-pricing-webhook-2026'

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
  } catch (err) {
    console.error('Telegram error:', err)
  }
}

async function getRunResults(datasetId) {
  const res = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&limit=10000`)
  return await res.json()
}

function buildTelegramMessage(totalUpdated, totalProducts, alerts) {
  const priceUps = alerts.filter(a => a.alert_type === 'price_up')
  const priceDowns = alerts.filter(a => a.alert_type === 'price_down')
  const unavailable = alerts.filter(a => a.alert_type === 'unavailable_ae')
  const backInStock = alerts.filter(a => a.alert_type === 'back_in_stock')
  const deliveryChanges = alerts.filter(a => a.alert_type === 'delivery_change')

  let msg = `🤖 تحديث AE التلقائي\n`
  msg += `━━━━━━━━━━━━━━━\n`
  msg += `✅ تم تحديث ${totalUpdated}/${totalProducts} منتج\n\n`

  if (unavailable.length) {
    msg += `🔴 مش موجود في الإمارات (${unavailable.length}):\n`
    for (const a of unavailable.slice(0, 20)) {
      msg += `• ${a.asin}\n`
    }
    if (unavailable.length > 20) msg += `  ...+${unavailable.length - 20} أكتر\n`
    msg += `\n`
  }

  if (backInStock.length) {
    msg += `✅ منتجات رجعت موجودة (${backInStock.length}):\n`
    for (const a of backInStock.slice(0, 10)) {
      msg += `• ${a.asin}${a.new_value ? ` — ${a.new_value} AED` : ''}\n`
    }
    if (backInStock.length > 10) msg += `  ...+${backInStock.length - 10} أكتر\n`
    msg += `\n`
  }

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
      const sign = diff > 0 ? '+' : ''
      msg += `• ${a.asin}: ${a.old_value}يوم ← ${a.new_value}يوم (${sign}${diff})\n`
    }
    if (deliveryChanges.length > 15) msg += `  ...+${deliveryChanges.length - 15} أكتر\n`
    msg += `\n`
  }

  if (alerts.length === 0) {
    msg += `✨ مفيش أي تنبيهات — كل المنتجات زي ما هي`
  } else {
    msg += `━━━━━━━━━━━━━━━\n🔔 إجمالي التنبيهات: ${alerts.length}`
  }

  return msg
}

export default async function handler(req, res) {
  // Verify secret
  if (req.query.secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const { resource } = req.body
    if (!resource) {
      return res.status(200).json({ ok: true, message: 'No resource' })
    }

    const runStatus = resource.status
    const runId = resource.id

    // Handle non-success cases
    if (runStatus !== 'SUCCEEDED') {
      await sendTelegram(
        `⚠️ Apify run AE ${runStatus}\n` +
        `Run ID: ${runId?.substring(0, 12)}\n` +
        `ممكن تحاول تاني يدوياً.`
      )
      // Still increment to avoid hanging
      const { data: state } = await supabase.from('scrape_state').select('*').eq('market', 'ae').single()
      if (state) {
        await supabase.from('scrape_state').update({
          completed_batches: (state.completed_batches || 0) + 1,
        }).eq('market', 'ae')
      }
      return res.status(200).json({ ok: true, status: runStatus })
    }

    // SUCCEEDED — process the data
    const datasetId = resource.defaultDatasetId
    if (!datasetId) {
      await sendTelegram(`⚠️ Apify run AE نجح بس مفيش datasetId`)
      return res.status(200).json({ ok: true })
    }

    // Fetch results
    const results = await getRunResults(datasetId)
    if (!Array.isArray(results)) {
      await sendTelegram(`⚠️ Apify dataset مش valid`)
      return res.status(200).json({ ok: true })
    }

    // Get state
    const { data: state, error: stateErr } = await supabase
      .from('scrape_state')
      .select('*')
      .eq('market', 'ae')
      .single()

    if (stateErr || !state) {
      console.error('No scrape state:', stateErr)
      return res.status(200).json({ ok: true, error: 'No state' })
    }

    const prevPrices = state.prev_data?.prevPrices || {}
    const prevDeliveryDays = state.prev_data?.prevDeliveryDays || {}
    const prevUnavailable = new Set(state.prev_data?.prevUnavailableAsins || [])
    const rejectedSet = new Set(state.prev_data?.rejectedAsins || [])
    const totalProducts = state.prev_data?.totalProducts || 0

    // Alert thresholds
    const PRICE_CHANGE_PCT_THRESHOLD = 3   // 3%
    const PRICE_CHANGE_ABS_THRESHOLD = 5   // 5 AED
    const DELIVERY_CHANGE_THRESHOLD = 2    // 2 days

    // Group by asin
    const byAsin = {}
    for (const row of results) {
      if (!byAsin[row.asin]) byAsin[row.asin] = []
      byAsin[row.asin].push(row)
    }

    // Process
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
        asin,
        price_aed: newPrice,
        delivery_days_ae: deliveryDays,
        delivery_date_ae: deliveryDate,
        last_scraped_ae: new Date().toISOString(),
        is_unavailable_ae: !available,
      })

      histories.push({
        asin,
        price_aed: newPrice,
        buy_box_seller: buyBoxRow?.seller_name || null,
        source: 'ae_update',
      })

      // SKIP alerts for rejected products
      if (rejectedSet.has(asin)) continue

      const prev = prevPrices[asin]
      const prevDays = prevDeliveryDays[asin]
      const wasUnavailable = prevUnavailable.has(asin)

      // === UNAVAILABLE / BACK IN STOCK ===
      if (!available && !wasUnavailable) {
        // First time becoming unavailable
        alerts.push({ asin, alert_type: 'unavailable_ae', old_value: prev, new_value: null, priority: 'critical' })
      } else if (available && wasUnavailable) {
        // Was unavailable, now available again
        alerts.push({ asin, alert_type: 'back_in_stock', old_value: null, new_value: newPrice, priority: 'important' })
      }
      // If still unavailable, NO new alert (prevents spam)

      // === PRICE CHANGES (only if available) ===
      if (available && newPrice && prev) {
        const diff = newPrice - prev
        const pctChange = Math.abs(diff / prev * 100)
        const absChange = Math.abs(diff)
        // Only alert if change exceeds BOTH thresholds (avoids noise)
        if (pctChange >= PRICE_CHANGE_PCT_THRESHOLD && absChange >= PRICE_CHANGE_ABS_THRESHOLD) {
          // Determine priority by magnitude
          const priority = pctChange >= 15 ? 'critical' : pctChange >= 7 ? 'important' : 'info'
          if (diff > 0) {
            alerts.push({ asin, alert_type: 'price_up', old_value: prev, new_value: newPrice, priority })
          } else {
            alerts.push({ asin, alert_type: 'price_down', old_value: prev, new_value: newPrice, priority })
          }
        }
      }

      // === DELIVERY CHANGE ===
      if (available && deliveryDays != null && prevDays != null
          && Math.abs(deliveryDays - prevDays) > DELIVERY_CHANGE_THRESHOLD) {
        alerts.push({ asin, alert_type: 'delivery_change', old_value: prevDays, new_value: deliveryDays, priority: 'info' })
      }
    }

    // Save to DB in parallel chunks
    const dbTasks = []
    for (const u of updates) {
      dbTasks.push(supabase.from('products').update({
        price_aed: u.price_aed,
        delivery_days_ae: u.delivery_days_ae,
        delivery_date_ae: u.delivery_date_ae,
        last_scraped_ae: u.last_scraped_ae,
      }).eq('asin', u.asin))
    }
    if (histories.length) dbTasks.push(supabase.from('price_history').insert(histories))
    if (alerts.length) dbTasks.push(supabase.from('price_alerts').insert(alerts))
    await Promise.all(dbTasks)

    // Atomic update with optimistic locking (handles concurrent webhooks)
    let isLastBatch = false
    let finalState = null
    let retries = 0
    const MAX_RETRIES = 10

    while (retries < MAX_RETRIES) {
      const { data: currentState } = await supabase
        .from('scrape_state')
        .select('*')
        .eq('market', 'ae')
        .single()

      if (!currentState) break

      const currentCompleted = currentState.completed_batches || 0
      const existingAlerts = currentState.all_alerts || []

      const { data: updated, error: updateErr } = await supabase
        .from('scrape_state')
        .update({
          completed_batches: currentCompleted + 1,
          all_alerts: [...existingAlerts, ...alerts],
          products_updated: (currentState.products_updated || 0) + updates.length,
        })
        .eq('market', 'ae')
        .eq('completed_batches', currentCompleted)  // optimistic lock
        .select()
        .maybeSingle()

      if (updated) {
        finalState = updated
        isLastBatch = updated.completed_batches >= updated.total_batches
        break
      }

      // Conflict - another webhook updated it. Retry with backoff
      retries++
      await new Promise(r => setTimeout(r, 100 + Math.random() * 300))
    }

    if (!finalState) {
      console.error('Failed to update scrape_state after retries')
      return res.status(200).json({ ok: true, warning: 'state_update_failed' })
    }

    // If all batches done, send final summary
    if (isLastBatch) {
      const totalUpdatedCount = finalState.products_updated
      const combinedAlerts = finalState.all_alerts || []
      // FAIL-SAFE: don't send false alerts if we got very few results
      const minExpected = Math.max(10, Math.floor(totalProducts * 0.3))
      if (totalUpdatedCount < minExpected) {
        await sendTelegram(
          `⚠️ تحديث AE فشل\n` +
          `━━━━━━━━━━━━━━━\n` +
          `الـ scrape رجع ${totalUpdatedCount}/${totalProducts} منتج فقط.\n` +
          `الحماية مفعلة — مفيش تنبيهات هتظهر.\n` +
          `هيتم المحاولة في التحديث الجاي.`
        )
      } else {
        const msg = buildTelegramMessage(totalUpdatedCount, totalProducts, combinedAlerts)
        await sendTelegram(msg)
      }

      await supabase.from('scrape_state').update({
        completed_at: new Date().toISOString(),
      }).eq('market', 'ae')
    }

    return res.status(200).json({
      ok: true,
      processed: updates.length,
      alerts: alerts.length,
      batches_done: finalState.completed_batches,
      total_batches: finalState.total_batches,
      is_last: isLastBatch,
    })
  } catch (err) {
    console.error('Webhook AE error:', err)
    await sendTelegram(`❌ خطأ في معالجة webhook AE:\n${err.message}`)
    return res.status(500).json({ error: err.message })
  }
}

export const config = { maxDuration: 300 }
