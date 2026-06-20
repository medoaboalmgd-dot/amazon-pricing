-- =====================================================
-- Migration: Seller monitoring + permanent shipping ref
-- =====================================================

-- 1. Make shipping_reference truly permanent (independent of products table)
--    It already stores asin + shipping_egp, but let's add weight/dims/status
--    so AI results are cached fully and never need re-querying.
ALTER TABLE shipping_reference ADD COLUMN IF NOT EXISTS ai_weight NUMERIC;
ALTER TABLE shipping_reference ADD COLUMN IF NOT EXISTS ai_dimensions TEXT;
ALTER TABLE shipping_reference ADD COLUMN IF NOT EXISTS ai_status TEXT;
ALTER TABLE shipping_reference ADD COLUMN IF NOT EXISTS shipping_suspicious BOOLEAN DEFAULT FALSE;
ALTER TABLE shipping_reference ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- 2. New table: seller monitoring data (all sellers per ASIN)
CREATE TABLE IF NOT EXISTS product_sellers (
  id BIGSERIAL PRIMARY KEY,
  asin TEXT NOT NULL,
  seller_id TEXT,
  seller_name TEXT,
  price_egp NUMERIC,
  position INT,
  is_buy_box BOOLEAN DEFAULT FALSE,
  is_us BOOLEAN DEFAULT FALSE,
  rating_text TEXT,
  rating_count INT,
  positive_pct TEXT,
  delivery_date TEXT,
  asin_total_sellers INT,
  scraped_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_sellers_asin ON product_sellers(asin);

-- Keep only latest snapshot per asin: we'll delete old rows for an asin
-- before inserting new ones (handled in app code), so no extra logic needed here.

-- 3. Add buy_box_position + total_sellers to product_eg_data for quick access
ALTER TABLE product_eg_data ADD COLUMN IF NOT EXISTS buy_box_position INT;
ALTER TABLE product_eg_data ADD COLUMN IF NOT EXISTS total_sellers INT;
ALTER TABLE product_eg_data ADD COLUMN IF NOT EXISTS our_position INT;
ALTER TABLE product_eg_data ADD COLUMN IF NOT EXISTS our_price_egp NUMERIC;

-- 4. Update the view: fix status order (active BEFORE awaiting)
--    and expose new seller-monitoring fields
DROP VIEW IF EXISTS v_products;

CREATE VIEW v_products AS
SELECT
  p.asin, p.title, p.image, p.brand, p.color, p.price_aed, p.stars, p.reviews_count,
  p.seller_name_ae, p.last_scraped_ae, p.not_in_catalog, p.awaiting_listing,
  p.rejected, p.rejection_reason, p.needs_price_fix,
  pp.shipping_egp, pp.min_price_egp, pp.max_price_egp, pp.pricing_complete,
  pp.shipping_source, pp.ai_weight, pp.ai_dimensions, pp.ai_status, pp.shipping_suspicious,
  pp.updated_at AS pricing_updated_at,
  eg.price_egp, eg.buy_box_seller, eg.buy_box_seller_id, eg.is_our_listing,
  eg.competitors, eg.last_scraped_eg,
  eg.buy_box_position, eg.total_sellers, eg.our_position, eg.our_price_egp,
  CASE
    WHEN p.rejected = TRUE AND p.needs_price_fix = TRUE THEN 'price_fix'
    WHEN p.rejected = TRUE THEN 'rejected'
    WHEN p.not_in_catalog = TRUE THEN 'rejected'
    WHEN pp.shipping_suspicious = TRUE THEN 'suspicious'
    WHEN pp.shipping_egp IS NULL THEN 'missing'
    WHEN eg.is_our_listing = TRUE THEN 'active'
    WHEN p.awaiting_listing = TRUE THEN 'awaiting'
    WHEN eg.price_egp IS NOT NULL AND pp.min_price_egp IS NOT NULL
      AND eg.price_egp < pp.min_price_egp THEN 'burnt'
    WHEN pp.pricing_complete = TRUE THEN 'ready'
    ELSE 'missing'
  END AS status,
  CASE
    WHEN eg.price_egp IS NOT NULL AND pp.min_price_egp IS NOT NULL
    THEN ROUND(((eg.price_egp - pp.min_price_egp) / pp.min_price_egp * 100)::NUMERIC, 1)
    ELSE NULL
  END AS price_diff_pct,
  -- price gap to buy box, only meaningful when we're listed but NOT buy box
  CASE
    WHEN eg.our_price_egp IS NOT NULL AND eg.price_egp IS NOT NULL
      AND eg.is_our_listing = FALSE AND eg.our_position IS NOT NULL
    THEN ROUND((eg.our_price_egp - eg.price_egp)::NUMERIC, 1)
    ELSE NULL
  END AS buy_box_gap
FROM products p
LEFT JOIN product_pricing pp ON p.asin = pp.asin
LEFT JOIN product_eg_data eg ON p.asin = eg.asin;
