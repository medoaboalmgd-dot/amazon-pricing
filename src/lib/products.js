import { supabase } from './supabase'
import { OUR_SELLER, OUR_SELLER_ID } from './constants'

// Get all products with status from view
export async function getProducts() {
  const pageSize = 1000
  let allData = []
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('v_products')
      .select('*')
      .order('last_scraped_ae', { ascending: false, nullsFirst: false })
      .range(from, from + pageSize - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    allData = allData.concat(data)
    if (data.length < pageSize) break
    from += pageSize
  }
  return allData
}

// Get settings (exchange rate etc)
export async function getSettings() {
  const { data, error } = await supabase.from('settings').select('*')
  if (error) throw error
  return Object.fromEntries(data.map(s => [s.key, s.value]))
}

// Update exchange rate
export async function updateExchangeRate(rate) {
  const { error } = await supabase
    .from('settings')
    .update({ value: String(rate), updated_at: new Date().toISOString() })
    .eq('key', 'exchange_rate')
  if (error) throw error
}

// Upsert products from AE scrape
export async function upsertProductsAE(products, jobId) {
  const seen = new Set()
  const rows = products
    .filter(p => p.availability && p.asin)
    .filter(p => { if (seen.has(p.asin)) return false; seen.add(p.asin); return true })
    .map(p => ({
      asin: p.asin,
      title: p.title,
      image: p.image,
      brand: p.categories?.brand || null,
      color: p.categories?.color || null,
      dimensions: p.categories?.item_depth_width_height || null,
      price_aed: parseFloat(p.price) || null,
      stars: parseFloat(p.stars) || null,
      reviews_count: parseInt(p.reviewsCount) || null,
      seller_name_ae: p.seller_name || null,
      seller_id_ae: p.seller_id || null,
      ae_url: p.url,
      job_id: jobId,
      last_scraped_ae: new Date().toISOString(),
    }))

  const { error } = await supabase
    .from('products')
    .upsert(rows, { onConflict: 'asin' })
  if (error) throw error
  return rows.length
}

// Upsert EG data
export async function upsertProductsEG(products) {
  const seenEg = new Set()
  const rows = products
    .filter(p => p.asin)
    .filter(p => { if (seenEg.has(p.asin)) return false; seenEg.add(p.asin); return true })
    .map(p => ({
      asin: p.asin,
      price_egp: parseFloat(p.price) || null,
      buy_box_seller: p.seller_name || null,
      buy_box_seller_id: p.seller_id || null,
      is_our_listing: p.seller_id === OUR_SELLER_ID || p.seller_name === OUR_SELLER,
      eg_url: p.url,
      last_scraped_eg: new Date().toISOString(),
    }))

  const { error } = await supabase
    .from('product_eg_data')
    .upsert(rows, { onConflict: 'asin' })
  if (error) throw error
}

// Save shipping for one product
export async function saveShipping(asin, shippingEgp) {
  const { error } = await supabase
    .from('product_pricing')
    .upsert({ asin, shipping_egp: shippingEgp }, { onConflict: 'asin' })
  if (error) throw error
}

// Save shipping from Excel bulk
export async function saveShippingBulk(rows) {
  // rows = [{asin, shipping_egp}]
  const { error } = await supabase
    .from('product_pricing')
    .upsert(rows, { onConflict: 'asin' })
  if (error) throw error
}

// Create scrape job
export async function createJob(aeUrl) {
  const { data, error } = await supabase
    .from('scrape_jobs')
    .insert({ ae_url: aeUrl, status: 'running' })
    .select()
    .single()
  if (error) throw error
  return data
}

// Update job status
export async function updateJob(jobId, updates) {
  const { error } = await supabase
    .from('scrape_jobs')
    .update(updates)
    .eq('id', jobId)
  if (error) throw error
}

// Get pending notifications
export async function getPendingNotifications() {
  const { data, error } = await supabase
    .from('v_pending_notifications')
    .select('*')
  if (error) throw error
  return data
}

// Mark notifications as sent
export async function markNotificationsSent(ids) {
  const { error } = await supabase
    .from('notifications')
    .update({ sent: true })
    .in('id', ids)
  if (error) throw error
}

// Delete products by ASINs (cascades to pricing + eg_data via FK)
export async function deleteProducts(asins) {
  const { error } = await supabase
    .from('products')
    .delete()
    .in('asin', asins)
  if (error) throw error
}

// Mark products as not in catalog
export async function markNotInCatalog(asins) {
  const { error } = await supabase
    .from('products')
    .update({ not_in_catalog: true })
    .in('asin', asins)
  if (error) throw error
}

// Unmark products from not_in_catalog (when they come back to catalog)
export async function unmarkNotInCatalog(asins) {
  const { error } = await supabase
    .from('products')
    .update({ not_in_catalog: false })
    .in('asin', asins)
  if (error) throw error
}

// Get price alerts
export async function getPriceAlerts() {
  const { data, error } = await supabase
    .from('price_alerts')
    .select('*, products(title, image, ae_url)')
    .eq('seen', false)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

// Mark alerts as seen
export async function markAlertsSeen(ids) {
  const { error } = await supabase
    .from('price_alerts')
    .update({ seen: true })
    .in('id', ids)
  if (error) throw error
}

// Save price alert
export async function savePriceAlert(asin, type, oldVal, newVal, priority = 'info') {
  const { error } = await supabase
    .from('price_alerts')
    .insert({ asin, alert_type: type, old_value: oldVal, new_value: newVal, priority })
  if (error) throw error
}

// Update AE prices for existing products
export async function updateAEPrices(products) {
  const seen = new Set()
  const rows = products
    .filter(p => p.asin)
    .filter(p => { if (seen.has(p.asin)) return false; seen.add(p.asin); return true })
    .map(p => ({
      asin: p.asin,
      price_aed: parseFloat(p.price) || null,
      availability: p.availability,
      last_scraped_ae: new Date().toISOString(),
    }))

  for (const row of rows) {
    const { error } = await supabase
      .from('products')
      .update({
        price_aed: row.price_aed,
        last_scraped_ae: row.last_scraped_ae,
      })
      .eq('asin', row.asin)
    if (error) throw error
  }
  return rows
}

// Mark products as awaiting listing
export async function markAwaitingListing(asins) {
  const { error } = await supabase
    .from('products')
    .update({ awaiting_listing: true })
    .in('asin', asins)
  if (error) throw error
}

// Mark products as no longer awaiting (moved to active)
export async function unmarkAwaitingListing(asins) {
  const { error } = await supabase
    .from('products')
    .update({ awaiting_listing: false })
    .in('asin', asins)
  if (error) throw error
}

// Save shipping reference (bulk) — manual entries
export async function saveShippingReference(rows) {
  const { error } = await supabase
    .from('shipping_reference')
    .upsert(rows, { onConflict: 'asin' })
  if (error) throw error
}

// Save AI-calculated shipping into the PERMANENT reference too,
// so re-scraping the same ASIN later never costs AI tokens again —
// even if the product was deleted in the meantime.
export async function saveAIShippingToReference(asin, shippingEgp, weight, dimensions, status, suspicious) {
  const { error } = await supabase
    .from('shipping_reference')
    .upsert({
      asin,
      shipping_egp: shippingEgp,
      ai_weight: weight,
      ai_dimensions: dimensions,
      ai_status: status,
      shipping_suspicious: suspicious,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'asin' })
  if (error) throw error
}

// Get full shipping reference map (asin -> {shipping_egp, ai_weight, ai_dimensions, ai_status, shipping_suspicious})
export async function getShippingReference() {
  const { data, error } = await supabase
    .from('shipping_reference')
    .select('asin, shipping_egp, ai_weight, ai_dimensions, ai_status, shipping_suspicious')
  if (error) throw error
  return Object.fromEntries((data || []).map(r => [r.asin, r]))
}

// Update AED price manually
export async function updateProductPrice(asin, priceAed) {
  const { error } = await supabase
    .from('products')
    .update({ price_aed: priceAed })
    .eq('asin', asin)
  if (error) throw error
}

// Mark products as rejected with reason
export async function markRejected(items) {
  // items = [{asin, reason, needs_price_fix}]
  for (const item of items) {
    const { error } = await supabase
      .from('products')
      .update({
        rejected: true,
        rejection_reason: item.reason,
        needs_price_fix: item.needs_price_fix || false,
        awaiting_listing: false,
      })
      .eq('asin', item.asin)
    if (error) throw error
  }
}

// Save AI-calculated shipping with metadata
export async function saveAIShipping(asin, shippingEgp, weight, dimensions, status, suspicious = false) {
  const { error } = await supabase
    .from('product_pricing')
    .upsert({
      asin,
      shipping_egp: shippingEgp,
      shipping_source: 'ai',
      ai_weight: weight,
      ai_dimensions: dimensions,
      ai_status: status,
      shipping_suspicious: suspicious,
    }, { onConflict: 'asin' })
  if (error) throw error
}

// Replace all seller rows for a set of ASINs with fresh data
export async function upsertProductSellers(asin, sellers) {
  // Delete old snapshot for this asin first
  await supabase.from('product_sellers').delete().eq('asin', asin)
  if (!sellers.length) return
  const rows = sellers.map(s => ({
    asin,
    seller_id: s.seller || null,
    seller_name: s.seller_name || null,
    price_egp: s.price ? parseFloat(String(s.price).replace(/,/g, '')) : null,
    position: s.position || null,
    is_buy_box: !!s.buy_box,
    is_us: s.seller_name === OUR_SELLER || s.seller === OUR_SELLER_ID,
    rating_text: (s.reviews && s.reviews[0]) || null,
    rating_count: s.reviews && s.reviews[1] ? parseInt((s.reviews[1].match(/\d+/) || [0])[0]) : null,
    positive_pct: (s.reviews && s.reviews.find(r => r.includes('positive'))) || null,
    delivery_date: (s.deliveries && s.deliveries[0]?.date) || null,
    asin_total_sellers: s.asin_total_sellers || sellers.length,
  }))
  const { error } = await supabase.from('product_sellers').insert(rows)
  if (error) throw error

  // Update summary fields on product_eg_data for quick filtering
  const buyBox = sellers.find(s => s.buy_box)
  const us = sellers.find(s => s.seller_name === OUR_SELLER || s.seller === OUR_SELLER_ID)
  const buyBoxPrice = buyBox?.price ? parseFloat(String(buyBox.price).replace(/,/g, '')) : null
  await supabase.from('product_eg_data').upsert({
    asin,
    price_egp: buyBoxPrice,
    buy_box_seller: buyBox?.seller_name || null,
    buy_box_seller_id: buyBox?.seller || null,
    buy_box_position: buyBox?.position || null,
    total_sellers: sellers[0]?.asin_total_sellers || sellers.length,
    our_position: us?.position || null,
    our_price_egp: us?.price ? parseFloat(String(us.price).replace(/,/g, '')) : null,
    is_our_listing: !!(us && us.buy_box),
    last_scraped_eg: new Date().toISOString(),
  }, { onConflict: 'asin' })
}

// Get all sellers for one ASIN (for the detail popup)
export async function getProductSellers(asin) {
  const { data, error } = await supabase
    .from('product_sellers')
    .select('*')
    .eq('asin', asin)
    .order('position', { ascending: true })
  if (error) throw error
  return data
}

// Check if ASINs are in Amazon Egypt catalog
export async function checkCatalog(asins) {
  const res = await fetch('/api/check-catalog', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ asins }),
  })
  const data = await res.json()
  // Returns { asin: true/false/null }
  return Object.fromEntries((data.results || []).map(r => [r.asin, r.in_catalog]))
}

// Update AE prices + delivery days from seller monitoring actor
export async function updateAEPricesWithDelivery(rows) {
  const errors = []
  await Promise.all(rows.map(async (row) => {
    const { error } = await supabase
      .from('products')
      .update({
        price_aed: row.price_aed,
        delivery_days_ae: row.delivery_days_ae,
        delivery_date_ae: row.delivery_date_ae,
        last_scraped_ae: row.last_scraped_ae,
      })
      .eq('asin', row.asin)
    if (error) {
      console.error('updateAEPricesWithDelivery error for', row.asin, ':', error)
      errors.push({ asin: row.asin, error: error.message })
    }
  }))
  if (errors.length) {
    console.error(`Failed to update ${errors.length} products:`, errors)
  }
  return { rows, errors }
}

// Save price history record
export async function savePriceHistory(asin, priceAed, priceEgp, buyBoxSeller, ourPriceEgp, source) {
  const { error } = await supabase.from('price_history').insert({
    asin, price_aed: priceAed, price_egp: priceEgp,
    buy_box_seller: buyBoxSeller, our_price_egp: ourPriceEgp, source,
  })
  if (error) console.error('savePriceHistory error:', error)
}

// Get price history for a product
export async function getPriceHistory(asin) {
  const { data, error } = await supabase
    .from('price_history')
    .select('*')
    .eq('asin', asin)
    .order('recorded_at', { ascending: true })
    .limit(90)
  if (error) throw error
  return data
}

// Confirm suspicious shipping (remove flag, keep shipping value)
export async function confirmSuspiciousShipping(asin) {
  const { error } = await supabase
    .from('product_pricing')
    .update({ shipping_suspicious: false })
    .eq('asin', asin)
  if (error) throw error
}

// Reject suspicious shipping (clear shipping so product goes back to missing)
export async function rejectSuspiciousShipping(asin) {
  const { error } = await supabase
    .from('product_pricing')
    .update({ shipping_suspicious: false, shipping_egp: null, ai_weight: null, ai_dimensions: null, ai_status: null, shipping_source: null })
    .eq('asin', asin)
  if (error) throw error
}

// === SELLERS AGGREGATION ===

export async function getAllSellers() {
  // Fetch ALL seller rows from product_sellers with pagination
  let all = []
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data, error } = await supabase
      .from('product_sellers')
      .select('seller_id, seller_name, asin, is_buy_box, price_egp, scraped_at, is_us')
      .not('seller_id', 'is', null)
      .range(from, from + PAGE - 1)
    if (error) throw error
    if (!data || !data.length) break
    all = all.concat(data)
    if (data.length < PAGE) break
    from += PAGE
  }

  // Exclude us (handles is_us=true OR our seller_id)
  all = all.filter(r => !r.is_us && r.seller_id !== OUR_SELLER_ID)

  // Fetch friend sellers
  const { data: friends } = await supabase.from('friend_sellers').select('*')
  const friendIds = new Set((friends || []).map(f => f.seller_id))

  // Aggregate per seller
  const map = {}
  for (const s of all) {
    if (!s.seller_id) continue
    if (!map[s.seller_id]) {
      map[s.seller_id] = {
        seller_id: s.seller_id,
        seller_name: s.seller_name || s.seller_id,
        asins: new Set(),
        buy_box_asins: new Set(),
        is_friend: friendIds.has(s.seller_id),
        last_seen: s.scraped_at,
      }
    }
    map[s.seller_id].asins.add(s.asin)
    if (s.is_buy_box) map[s.seller_id].buy_box_asins.add(s.asin)
    if (s.scraped_at && (!map[s.seller_id].last_seen || s.scraped_at > map[s.seller_id].last_seen)) {
      map[s.seller_id].last_seen = s.scraped_at
    }
  }

  return Object.values(map).map(s => ({
    seller_id: s.seller_id,
    seller_name: s.seller_name,
    product_count: s.asins.size,
    buy_box_count: s.buy_box_asins.size,
    is_friend: s.is_friend,
    last_seen: s.last_seen,
    asins: Array.from(s.asins),
  })).sort((a, b) => b.product_count - a.product_count)
}

// Products of a specific seller (with details)
export async function getSellerProducts(sellerId) {
  // Get all rows for this seller (no is_us filter — we handle in JS)
  let rows = []
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data } = await supabase
      .from('product_sellers')
      .select('asin, is_buy_box, price_egp, position, scraped_at, is_us')
      .eq('seller_id', sellerId)
      .range(from, from + PAGE - 1)
    if (!data || !data.length) break
    rows = rows.concat(data)
    if (data.length < PAGE) break
    from += PAGE
  }

  // Exclude our own (us = true)
  rows = rows.filter(r => !r.is_us)
  if (!rows.length) return []

  const asins = [...new Set(rows.map(r => r.asin))]
  // Fetch product details
  const { data: products } = await supabase
    .from('v_products')
    .select('*')
    .in('asin', asins)

  const pMap = {}
  for (const p of products || []) pMap[p.asin] = p

  // Combine — include products even if not in v_products (fallback with just asin)
  return rows.map(r => ({
    ...r,
    product: pMap[r.asin] || { asin: r.asin, title: '(منتج محذوف من قاعدة البيانات)' },
  })).sort((a, b) => (b.is_buy_box ? 1 : 0) - (a.is_buy_box ? 1 : 0))
}

// Friend management
export async function addFriendSeller(sellerId, sellerName, note = '') {
  const { error } = await supabase
    .from('friend_sellers')
    .upsert({ seller_id: sellerId, seller_name: sellerName, note }, { onConflict: 'seller_id' })
  return !error
}

export async function removeFriendSeller(sellerId) {
  const { error } = await supabase
    .from('friend_sellers')
    .delete()
    .eq('seller_id', sellerId)
  return !error
}

export async function getFriendSellers() {
  const { data } = await supabase
    .from('friend_sellers')
    .select('*')
    .order('added_at', { ascending: false })
  return data || []
}

// Auto-reject products where a friend is now the buy box / a seller
export async function rejectProductsWithFriends() {
  const friends = await getFriendSellers()
  if (!friends.length) return 0
  const friendIds = new Set(friends.map(f => f.seller_id))
  const friendNamesById = Object.fromEntries(friends.map(f => [f.seller_id, f.seller_name]))

  // Find product_sellers rows where seller_id is a friend AND product not already rejected
  let allRows = []
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data } = await supabase
      .from('product_sellers')
      .select('asin, seller_id')
      .in('seller_id', [...friendIds])
      .range(from, from + PAGE - 1)
    if (!data || !data.length) break
    allRows = allRows.concat(data)
    if (data.length < PAGE) break
    from += PAGE
  }

  // For each affected ASIN, mark rejected
  const affected = {}
  for (const r of allRows) {
    if (!affected[r.asin]) affected[r.asin] = friendNamesById[r.seller_id] || r.seller_id
  }
  const affectedAsins = Object.keys(affected)
  if (!affectedAsins.length) return 0

  // Mark them rejected (skip already-rejected)
  let count = 0
  for (const asin of affectedAsins) {
    const { data: cur } = await supabase
      .from('products').select('rejected').eq('asin', asin).maybeSingle()
    if (cur && !cur.rejected) {
      await supabase.from('products').update({
        rejected: true,
        rejection_reason: `صديق بيبيعه (${affected[asin]})`,
      }).eq('asin', asin)
      count++
    }
  }
  return count
}
