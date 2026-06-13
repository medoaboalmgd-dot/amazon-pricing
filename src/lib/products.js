import { supabase } from './supabase'

// Get all products with status from view
export async function getProducts() {
  const { data, error } = await supabase
    .from('v_products')
    .select('*')
    .order('last_scraped_ae', { ascending: false })
  if (error) throw error
  return data
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
  const rows = products
    .filter(p => p.availability && p.asin)
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
  const OUR_SELLER = 'BestQualityBestPrice'
  const rows = products
    .filter(p => p.asin)
    .map(p => ({
      asin: p.asin,
      price_egp: parseFloat(p.price) || null,
      buy_box_seller: p.seller_name || null,
      buy_box_seller_id: p.seller_id || null,
      is_our_listing: p.seller_name === OUR_SELLER,
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

// Get price history for a product
export async function getPriceHistory(asin) {
  const { data, error } = await supabase
    .from('price_history')
    .select('*')
    .eq('asin', asin)
    .order('recorded_at', { ascending: false })
    .limit(30)
  if (error) throw error
  return data
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
