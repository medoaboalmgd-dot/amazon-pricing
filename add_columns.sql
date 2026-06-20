-- Add not_in_catalog status to products
ALTER TABLE products ADD COLUMN IF NOT EXISTS not_in_catalog BOOLEAN DEFAULT FALSE;

-- Add price alerts table
CREATE TABLE IF NOT EXISTS price_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asin TEXT REFERENCES products(asin) ON DELETE CASCADE,
  alert_type TEXT NOT NULL, -- 'price_up' | 'unavailable'
  old_value NUMERIC,
  new_value NUMERIC,
  seen BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE price_alerts DISABLE ROW LEVEL SECURITY;

-- Update v_products view to include not_in_catalog
CREATE OR REPLACE VIEW v_products AS
SELECT
  p.asin,
  p.title,
  p.image,
  p.brand,
  p.color,
  p.price_aed,
  p.stars,
  p.reviews_count,
  p.seller_name_ae,
  p.last_scraped_ae,
  p.not_in_catalog,
  pp.shipping_egp,
  pp.min_price_egp,
  pp.max_price_egp,
  pp.pricing_complete,
  pp.updated_at AS pricing_updated_at,
  eg.price_egp,
  eg.buy_box_seller,
  eg.buy_box_seller_id,
  eg.is_our_listing,
  eg.competitors,
  eg.last_scraped_eg,
  CASE
    WHEN p.not_in_catalog = TRUE THEN 'not_in_catalog'
    WHEN pp.shipping_egp IS NULL THEN 'missing'
    WHEN eg.is_our_listing = TRUE THEN 'active'
    WHEN eg.price_egp IS NOT NULL AND pp.min_price_egp IS NOT NULL
      AND eg.price_egp < pp.min_price_egp THEN 'burnt'
    WHEN pp.pricing_complete = TRUE THEN 'ready'
    ELSE 'missing'
  END AS status,
  CASE
    WHEN eg.price_egp IS NOT NULL AND pp.min_price_egp IS NOT NULL
    THEN ROUND(((eg.price_egp - pp.min_price_egp) / pp.min_price_egp * 100)::NUMERIC, 1)
    ELSE NULL
  END AS price_diff_pct
FROM products p
LEFT JOIN product_pricing pp ON p.asin = pp.asin
LEFT JOIN product_eg_data eg ON p.asin = eg.asin;
