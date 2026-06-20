// Vercel Cron: Starts Apify scrape for AE prices with WEBHOOK callback
// Returns immediately - actual processing happens in apify-webhook-ae.js
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
const APIFY_TOKEN = process.env.APIFY_TOKEN || process.env.VITE_APIFY_TOKEN
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.VITE_TELEGRAM_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.VITE_TELEGRAM_CHAT_ID
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'amazon-pricing-webhook-2026'
const APP_URL = process.env.APP_URL || 'https://amazon-pricing.vercel.app'

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

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

async function startApifyRun(asins, webhookUrl) {
  try {
    // Apify expects webhooks as base64-encoded query parameter (NOT in body)
    const webhooksConfig = [{
      eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED', 'ACTOR.RUN.TIMED_OUT', 'ACTOR.RUN.ABORTED'],
      requestUrl: webhookUrl,
    }]
    const webhooksParam = Buffer.from(JSON.stringify(webhooksConfig)).toString('base64')

    const res = await fetch(
      `https://api.apify.com/v2/acts/saswave~amazon-seller-monitoring/runs?token=${APIFY_TOKEN}&maxTotalChargeUsd=50&webhooks=${webhooksParam}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amazon_domain: 'www.amazon.ae',
          asins,
          first_ten_sellers: false,
          get_amazon: true,
          use_apify_dataset: true,
        }),
      }
    )
    const data = await res.json()
    return { runId: data.data?.id || null, status: res.status, raw: data }
  } catch (err) {
    return { runId: null, error: err.message }
  }
}

export default async function handler(req, res) {
  // Verify cron secret
  const authHeader = req.headers.authorization
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    // Get all non-rejected products
    const { data: products, error: prodErr } = await supabase
      .from('v_products')
      .select('asin, price_aed, delivery_days_ae, status')
      .neq('status', 'rejected')

    if (prodErr) throw prodErr
    if (!products?.length) return res.status(200).json({ message: 'No products' })

    // Also fetch rejected ASINs (for alert exclusion) + is_unavailable_ae
    const { data: allProducts } = await supabase
      .from('products')
      .select('asin, is_unavailable_ae')

    const { data: rejectedRows } = await supabase
      .from('v_products')
      .select('asin')
      .eq('status', 'rejected')

    const allAsins = products.map(p => p.asin)
    const prevPrices = Object.fromEntries(products.map(p => [p.asin, p.price_aed]))
    const prevDeliveryDays = Object.fromEntries(products.map(p => [p.asin, p.delivery_days_ae]))
    const prevUnavailableAsins = (allProducts || []).filter(p => p.is_unavailable_ae).map(p => p.asin)
    const rejectedAsins = (rejectedRows || []).map(p => p.asin)

    // Apify actor max is 30 ASINs per run (verified)
    const BATCH_SIZE = 30
    const batches = []
    for (let i = 0; i < allAsins.length; i += BATCH_SIZE) {
      batches.push(allAsins.slice(i, i + BATCH_SIZE))
    }

    // Save state for webhook to use
    await supabase.from('scrape_state').upsert({
      market: 'ae',
      prev_data: {
        prevPrices,
        prevDeliveryDays,
        prevUnavailableAsins,
        rejectedAsins,
        totalProducts: allAsins.length,
      },
      total_batches: batches.length,
      completed_batches: 0,
      all_alerts: [],
      products_updated: 0,
      started_at: new Date().toISOString(),
      completed_at: null,
    })

    // Start runs in groups of 3 (avoid rate limits)
    const webhookUrl = `${APP_URL}/api/apify-webhook-ae?secret=${WEBHOOK_SECRET}`
    const runs = []
    const PARALLEL = 3
    for (let i = 0; i < batches.length; i += PARALLEL) {
      const group = batches.slice(i, i + PARALLEL)
      const results = await Promise.all(group.map(b => startApifyRun(b, webhookUrl)))
      runs.push(...results)
    }

    const successCount = runs.filter(r => r.runId).length
    const failedRuns = runs.filter(r => !r.runId)

    if (successCount === 0) {
      await sendTelegram(
        `❌ فشل بدء تحديث AE\n` +
        `━━━━━━━━━━━━━━━\n` +
        `مفيش ولا run اتبدا في Apify.\n` +
        `Error: ${failedRuns[0]?.error || JSON.stringify(failedRuns[0]?.raw).substring(0, 200)}`
      )
      return res.status(500).json({ error: 'Failed to start runs', details: runs })
    }

    // Update total_batches based on actual successful runs
    await supabase.from('scrape_state').update({
      total_batches: successCount,
    }).eq('market', 'ae')

    await sendTelegram(
      `🤖 بدأ تحديث AE التلقائي\n` +
      `━━━━━━━━━━━━━━━\n` +
      `📦 ${allAsins.length} منتج (${successCount} جزء × ${BATCH_SIZE} منتج)\n` +
      `⏳ النتيجة هتجيلك خلال 10-20 دقيقة\n` +
      `${failedRuns.length ? `⚠️ ${failedRuns.length} جزء فشل البدء` : ''}`
    )

    return res.status(200).json({
      success: true,
      total_products: allAsins.length,
      batches_started: successCount,
      batches_failed: failedRuns.length,
      run_ids: runs.map(r => r.runId).filter(Boolean),
    })
  } catch (err) {
    console.error('Cron AE error:', err)
    await sendTelegram(`❌ خطأ في بدء تحديث AE التلقائي:\n${err.message}`)
    return res.status(500).json({ error: err.message })
  }
}

export const config = { maxDuration: 60 }
