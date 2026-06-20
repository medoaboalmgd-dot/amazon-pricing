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
    -- We're listed but NOT holding buy box → special "active but losing buybox" status
    WHEN eg.our_position IS NOT NULL AND eg.our_position > 1 THEN 'lost_buybox'
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
  CASE
    WHEN eg.our_price_egp IS NOT NULL AND eg.price_egp IS NOT NULL
      AND eg.our_position IS NOT NULL AND eg.our_position > 1
    THEN ROUND((eg.our_price_egp - eg.price_egp)::NUMERIC, 1)
    ELSE NULL
  END AS buy_box_gap
FROM products p
LEFT JOIN product_pricing pp ON p.asin = pp.asin
LEFT JOIN product_eg_data eg ON p.asin = eg.asin;
