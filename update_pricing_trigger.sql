-- Rounding to nearest 49/99 (up or down, whichever is closest)
CREATE OR REPLACE FUNCTION round_to_49_99(price NUMERIC)
RETURNS NUMERIC AS $$
DECLARE
  base NUMERIC;
  candidates NUMERIC[];
  best NUMERIC;
  c NUMERIC;
BEGIN
  IF price IS NULL THEN RETURN NULL; END IF;
  base := FLOOR(price / 100) * 100;
  candidates := ARRAY[base - 51, base - 1, base + 49, base + 99, base + 149];
  best := candidates[1];
  FOREACH c IN ARRAY candidates LOOP
    IF ABS(c - price) < ABS(best - price) THEN
      best := c;
    END IF;
  END LOOP;
  RETURN best;
END;
$$ LANGUAGE plpgsql;

-- Pricing trigger: cost = aed*rate + shipping; min = cost*1.35; max = cost*1.55; rounded
CREATE OR REPLACE FUNCTION calc_prices()
RETURNS TRIGGER AS $$
DECLARE
  rate NUMERIC;
  cost NUMERIC;
  min_m NUMERIC;
  max_m NUMERIC;
  ae_price NUMERIC;
BEGIN
  SELECT value::NUMERIC INTO rate FROM settings WHERE key = 'exchange_rate';
  SELECT value::NUMERIC INTO min_m FROM settings WHERE key = 'min_margin';
  SELECT value::NUMERIC INTO max_m FROM settings WHERE key = 'max_margin';
  SELECT price_aed INTO ae_price FROM products WHERE asin = NEW.asin;

  cost := ae_price * rate + NEW.shipping_egp;
  NEW.min_price_egp := round_to_49_99(cost * (1 + min_m));
  NEW.max_price_egp := round_to_49_99(cost * (1 + max_m));
  NEW.pricing_complete := TRUE;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
