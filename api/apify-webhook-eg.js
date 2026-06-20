// Apify Webhook: Called when EG scrape run completes
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
const APIFY_TOKEN = process.env.APIFY_TOKEN || process.env.VITE_APIFY_TOKEN
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.VITE_TELEGRAM_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.VITE_TELEGRAM_CHAT_ID
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'amazon-pricing-webhook-2026'
const OUR_SELLER = 'BestQualityBestPrice'
const OUR_SELLER_ID = 'A25ACUE2T1TUS6'

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

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

async function getRunResults(datasetId) {
  const res = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&limit=10000`)
  return await res.json()
}

export default async function handler(req, res) {
  if (req.query.secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const { resource } = req.body
    if (!resource) return res.status(200).json({ ok: true })

    if (resource.status !== 'SUCCEEDED') {
      await sendTelegram(`⚠️ Apify run EG ${resource.status}\nRun ID: ${resource.id?.substring(0,12)}`)
      const { data: state } = await supabase.from('scrape_state').select('*').eq('market', 'eg').single()
      if (state) {
        await supabase.from('scrape_state').update({
          completed_batches: (state.completed_batches || 0) + 1,
        }).eq('market', 'eg')
      }
      return res.status(200).json({ ok: true })
    }

    const datasetId = resource.defaultDatasetId
    const results = await getRunResults(datasetId)
    if (!Array.isArray(results)) {
      return res.status(200).json({ ok: true })
    }

    const { data: state } = await supabase.from('scrape_state').select('*').eq('market', 'eg').single()
    if (!state) return res.status(200).json({ ok: true })

    const totalProducts = state.prev_data?.totalProducts || 0

    // Group by asin
    const byAsin = {}
    for (const row of results) {
      if (!byAsin[row.asin]) byAsin[row.asin] = []
      byAsin[row.asin].push(row)
    }

    // Load friend sellers (to auto-reject products they sell)
    const { data: friendsData } = await supabase.from('friend_sellers').select('seller_id, seller_name')
    const friendsById = Object.fromEntries((friendsData || []).map(f => [f.seller_id, f.seller_name]))

    let processedCount = 0
    const alerts = []
    const histories = []

    const prevListedSet = new Set(state.prev_data?.prevListedAsins || [])
    const prevBuyBoxSet = new Set(state.prev_data?.prevBuyBoxAsins || [])
    const productCosts = state.prev_data?.productCosts || {}
    const productMinPrices = state.prev_data?.productMinPrices || {}
    const rejectedSet = new Set(state.prev_data?.rejectedAsins || [])

    // Thresholds
    const LOW_PROFIT_MARGIN_PCT = 10  // alert if profit < 10% of cost

    for (const [asin, sellers] of Object.entries(byAsin)) {
      const buyBox = sellers.find(s => s.buy_box)
      const us = sellers.find(s => s.seller_name === OUR_SELLER || s.seller === OUR_SELLER_ID)
      const buyBoxPrice = buyBox?.price ? parseFloat(String(buyBox.price).replace(/,/g, '')) : null
      const ourPrice = us?.price ? parseFloat(String(us.price).replace(/,/g, '')) : null

      // Delete old sellers + insert new
      await supabase.from('product_sellers').delete().eq('asin', asin)
      const sellerRows = sellers.map(s => ({
        asin,
        seller_id: s.seller || null,
        seller_name: s.seller_name || null,
        price_egp: s.price ? parseFloat(String(s.price).replace(/,/g, '')) : null,
        position: s.position || null,
        is_buy_box: !!s.buy_box,
        is_us: s.seller_name === OUR_SELLER || s.seller === OUR_SELLER_ID,
        rating_text: s.reviews?.[0] || null,
        rating_count: s.reviews?.[1] || null,
        positive_pct: s.reviews?.[2] || null,
        delivery_date: s.deliveries?.[0]?.date || null,
        asin_total_sellers: s.asin_total_sellers || sellers.length,
      }))
      if (sellerRows.length) await supabase.from('product_sellers').insert(sellerRows)

      // Update EG summary
      await supabase.from('product_eg_data').upsert({
        asin,
        price_egp: buyBoxPrice,
        buy_box_seller: buyBox?.seller_name || null,
        buy_box_seller_id: buyBox?.seller || null,
        buy_box_position: buyBox?.position || null,
        total_sellers: sellers[0]?.asin_total_sellers || sellers.length,
        our_position: us?.position || null,
        our_price_egp: ourPrice,
        is_our_listing: !!(us && us.buy_box),
        last_scraped_eg: new Date().toISOString(),
      }, { onConflict: 'asin' })

      if (us) {
        await supabase.from('products').update({ awaiting_listing: false }).eq('asin', asin)
      }

      // Auto-reject if a friend seller is selling this product
      const friendSeller = sellers.find(s => friendsById[s.seller])
      if (friendSeller) {
        await supabase.from('products').update({
          rejected: true,
          rejection_reason: `صديق بيبيعه (${friendsById[friendSeller.seller]})`,
        }).eq('asin', asin)
      }

      histories.push({
        asin,
        price_egp: buyBoxPrice,
        buy_box_seller: buyBox?.seller_name || null,
        our_price_egp: ourPrice,
        source: 'eg_update',
      })

      processedCount++

      // === ALERTS ===
      // Skip rejected products (no alerts)
      if (rejectedSet.has(asin)) continue

      // 1. friend_competitor_appeared — صديق دخل بائع
      if (friendSeller) {
        alerts.push({
          asin,
          alert_type: 'friend_competitor',
          old_value: null,
          new_value: null,
          priority: 'critical',
          meta: { friend_name: friendsById[friendSeller.seller] },
        })
      }

      // 2. delisted — كنت بائع، دلوقتي مش بائع
      if (prevListedSet.has(asin) && !us) {
        alerts.push({ asin, alert_type: 'delisted', old_value: null, new_value: null, priority: 'critical' })
      }

      // 3. buy_box_lost — كنت ماسك الـ buy box، دلوقتي مش ماسك
      const wasBuyBox = prevBuyBoxSet.has(asin)
      const isBuyBox = !!(us && us.buy_box)
      if (wasBuyBox && !isBuyBox && us) {
        alerts.push({
          asin,
          alert_type: 'buy_box_lost',
          old_value: ourPrice,
          new_value: buyBoxPrice,
          priority: 'critical',
        })
      }

      // 4. buy_box_regained — مكنش معاك الـ buy box، دلوقتي معاك
      if (!wasBuyBox && isBuyBox && prevListedSet.has(asin)) {
        alerts.push({
          asin,
          alert_type: 'buy_box_regained',
          old_value: null,
          new_value: ourPrice,
          priority: 'important',
        })
      }

      // 5. price_drop_below_cost — السوق نزل تحت التكلفة (هتخسر)
      const cost = productCosts[asin]
      if (cost && buyBoxPrice && buyBoxPrice < cost) {
        alerts.push({
          asin,
          alert_type: 'price_drop_below_cost',
          old_value: cost,
          new_value: buyBoxPrice,
          priority: 'critical',
        })
      }

      // 6. low_profit — الربح في السوق قليل
      if (cost && buyBoxPrice && buyBoxPrice >= cost) {
        const profitPct = ((buyBoxPrice - cost) / cost) * 100
        if (profitPct < LOW_PROFIT_MARGIN_PCT && profitPct >= 0) {
          alerts.push({
            asin,
            alert_type: 'low_profit',
            old_value: cost,
            new_value: buyBoxPrice,
            priority: 'important',
            meta: { profit_pct: Math.round(profitPct * 10) / 10 },
          })
        }
      }
    }

    if (histories.length) await supabase.from('price_history').insert(histories)
    if (alerts.length) await supabase.from('price_alerts').insert(alerts)

    // Atomic update with optimistic locking
    let isLastBatch = false
    let finalState = null
    let retries = 0
    const MAX_RETRIES = 10

    while (retries < MAX_RETRIES) {
      const { data: currentState } = await supabase
        .from('scrape_state')
        .select('*')
        .eq('market', 'eg')
        .single()

      if (!currentState) break

      const currentCompleted = currentState.completed_batches || 0
      const existingAlerts = currentState.all_alerts || []

      const { data: updated } = await supabase
        .from('scrape_state')
        .update({
          completed_batches: currentCompleted + 1,
          all_alerts: [...existingAlerts, ...alerts],
          products_updated: (currentState.products_updated || 0) + processedCount,
        })
        .eq('market', 'eg')
        .eq('completed_batches', currentCompleted)
        .select()
        .maybeSingle()

      if (updated) {
        finalState = updated
        isLastBatch = updated.completed_batches >= updated.total_batches
        break
      }

      retries++
      await new Promise(r => setTimeout(r, 100 + Math.random() * 300))
    }

    if (!finalState) {
      return res.status(200).json({ ok: true, warning: 'state_update_failed' })
    }

    // Final summary if all batches done
    if (isLastBatch) {
      const totalUpdatedCount = finalState.products_updated
      const combinedAlerts = finalState.all_alerts || []
      const minExpected = Math.max(10, Math.floor(totalProducts * 0.3))
      if (totalUpdatedCount < minExpected) {
        await sendTelegram(
          `⚠️ تحديث EG فشل\n` +
          `الـ scrape رجع ${totalUpdatedCount}/${totalProducts} منتج فقط.\n` +
          `الحماية مفعلة.`
        )
      } else {
        let msg = `🤖 تحديث EG التلقائي\n`
        msg += `━━━━━━━━━━━━━━━\n`
        msg += `✅ تم تحديث ${totalUpdatedCount}/${totalProducts} منتج\n\n`

        if (combinedAlerts.length) {
          const byType = (t) => combinedAlerts.filter(a => a.alert_type === t)
          const buyBoxLost = byType('buy_box_lost')
          const buyBoxRegained = byType('buy_box_regained')
          const priceDropBelowCost = byType('price_drop_below_cost')
          const lowProfit = byType('low_profit')
          const friendCompetitor = byType('friend_competitor')
          const delisted = byType('delisted')

          // === CRITICAL ===
          if (friendCompetitor.length) {
            msg += `⚠️ صديق دخل بائع (${friendCompetitor.length}) — اتم رفضهم:\n`
            for (const a of friendCompetitor.slice(0, 10)) {
              const name = a.meta?.friend_name || ''
              msg += `• ${a.asin}${name ? ` — ${name}` : ''}\n`
            }
            if (friendCompetitor.length > 10) msg += `  ...+${friendCompetitor.length - 10} أكتر\n`
            msg += `\n`
          }

          if (buyBoxLost.length) {
            msg += `👑❌ خسرت Buy Box (${buyBoxLost.length}):\n`
            for (const a of buyBoxLost.slice(0, 15)) {
              msg += `• ${a.asin}: سعرك ${a.old_value} → السوق ${a.new_value} EGP\n`
            }
            if (buyBoxLost.length > 15) msg += `  ...+${buyBoxLost.length - 15} أكتر\n`
            msg += `\n`
          }

          if (priceDropBelowCost.length) {
            msg += `💸 السوق نزل تحت التكلفة (${priceDropBelowCost.length}):\n`
            for (const a of priceDropBelowCost.slice(0, 15)) {
              const loss = Math.round(Number(a.old_value) - Number(a.new_value))
              msg += `• ${a.asin}: تكلفة ${Math.round(a.old_value)} → سوق ${Math.round(a.new_value)} (خسارة ${loss} EGP)\n`
            }
            if (priceDropBelowCost.length > 15) msg += `  ...+${priceDropBelowCost.length - 15} أكتر\n`
            msg += `\n`
          }

          if (delisted.length) {
            msg += `🟠 مبقاش معروض في مصر (${delisted.length}):\n`
            for (const a of delisted.slice(0, 15)) {
              msg += `• ${a.asin}\n`
            }
            if (delisted.length > 15) msg += `  ...+${delisted.length - 15} أكتر\n`
            msg += `\n`
          }

          // === IMPORTANT ===
          if (buyBoxRegained.length) {
            msg += `🎉 استرجعت Buy Box (${buyBoxRegained.length}):\n`
            for (const a of buyBoxRegained.slice(0, 10)) {
              msg += `• ${a.asin}${a.new_value ? ` — ${a.new_value} EGP` : ''}\n`
            }
            if (buyBoxRegained.length > 10) msg += `  ...+${buyBoxRegained.length - 10} أكتر\n`
            msg += `\n`
          }

          if (lowProfit.length) {
            msg += `📉 هامش ربح قليل (${lowProfit.length}):\n`
            for (const a of lowProfit.slice(0, 15)) {
              const pct = a.meta?.profit_pct ?? '?'
              msg += `• ${a.asin}: ربح ${pct}% (تكلفة ${Math.round(a.old_value)} → سوق ${Math.round(a.new_value)})\n`
            }
            if (lowProfit.length > 15) msg += `  ...+${lowProfit.length - 15} أكتر\n`
            msg += `\n`
          }

          msg += `━━━━━━━━━━━━━━━\n🔔 إجمالي التنبيهات: ${combinedAlerts.length}`
        } else {
          msg += `✨ مفيش أي تنبيهات — كل حاجة تمام`
        }
        await sendTelegram(msg)
      }

      await supabase.from('scrape_state').update({
        completed_at: new Date().toISOString(),
      }).eq('market', 'eg')
    }

    return res.status(200).json({ ok: true, processed: processedCount, alerts: alerts.length, is_last: isLastBatch })
  } catch (err) {
    console.error('Webhook EG error:', err)
    await sendTelegram(`❌ خطأ في معالجة webhook EG:\n${err.message}`)
    return res.status(500).json({ error: err.message })
  }
}

export const config = { maxDuration: 300 }
