INSERT INTO "model_prices" (
  "model",
  "input_cost_per_million_usd",
  "output_cost_per_million_usd",
  "cache_read_cost_per_million_usd",
  "cache_write_cost_per_million_usd"
)
VALUES
  ('gpt-5.5', 5.00, 30.00, 0.50, 6.25)
ON CONFLICT ("model") DO NOTHING;
