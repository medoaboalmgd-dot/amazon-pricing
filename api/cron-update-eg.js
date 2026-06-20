// Vercel Cron: Starts Apify scrape for EG sellers with WEBHOOK callback
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
          amazon_domain: 'www.amazon.eg',
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
  const authHeader = req.headers.authorization
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    // Fetch products with full pricing info needed for alerts
    const { data: products, error: prodErr } = await supabase
      .from('v_products')
      .select('asin, status, price_aed, shipping_egp, min_price_egp, is_our_listing, our_price_egp')
      .neq('status', 'rejected')
      .neq('status', 'missing')

    if (prodErr) throw prodErr
    if (!products?.length) return res.status(200).json({ message: 'No products' })

    // Get exchange rate
    const { data: rateRow } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'exchange_rate_aed_to_egp')
      .maybeSingle()
    const exchangeRate = parseFloat(rateRow?.value || '14.5')

    // Get rejected ASINs (to skip alerts for them)
    const { data: rejectedRows } = await supabase
      .from('v_products')
      .select('asin')
      .eq('status', 'rejected')
    const rejectedAsins = (rejectedRows || []).map(p => p.asin)

    const allAsins = products.map(p => p.asin)
    const prevListedAsins = products.filter(p => p.status === 'active' || p.status === 'lost_buybox').map(p => p.asin)
    const prevBuyBoxAsins = products.filter(p => p.is_our_listing).map(p => p.asin)

    // Cost per product (in EGP): price_aed * rate + shipping_egp
    const productCosts = {}
    const productMinPrices = {}
    for (const p of products) {
      if (p.price_aed && p.shipping_egp != null) {
        productCosts[p.asin] = (p.price_aed * exchangeRate) + p.shipping_egp
      }
      if (p.min_price_egp != null) productMinPrices[p.asin] = p.min_price_egp
    }

    const BATCH_SIZE = 30
    const batches = []
    for (let i = 0; i < allAsins.length; i += BATCH_SIZE) {
      batches.push(allAsins.slice(i, i + BATCH_SIZE))
    }

    await supabase.from('scrape_state').upsert({
      market: 'eg',
      prev_data: {
        prevListedAsins,
        prevBuyBoxAsins,
        productCosts,
        productMinPrices,
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

    const webhookUrl = `${APP_URL}/api/apify-webhook-eg?secret=${WEBHOOK_SECRET}`
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
        `❌ فشل بدء تحديث EG\n` +
        `━━━━━━━━━━━━━━━\n` +
        `Error: ${failedRuns[0]?.error || JSON.stringify(failedRuns[0]?.raw).substring(0, 200)}`
      )
      return res.status(500).json({ error: 'Failed to start runs', details: runs })
    }

    await supabase.from('scrape_state').update({
      total_batches: successCount,
    }).eq('market', 'eg')

    await sendTelegram(
      `🤖 بدأ تحديث EG التلقائي\n` +
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
    })
  } catch (err) {
    console.error('Cron EG error:', err)
    await sendTelegram(`❌ خطأ في بدء تحديث EG التلقائي:\n${err.message}`)
    return res.status(500).json({ error: err.message })
  }
}

export const config = { maxDuration: 60 }
