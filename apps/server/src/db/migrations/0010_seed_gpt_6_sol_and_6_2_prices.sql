-- Standard, short-context OpenAI API rates in USD per million text tokens,
-- with the default 30-minute cache-write rate, verified on 2026-11-23.
-- Keep administrator-configured prices when upgrading an existing database.
INSERT INTO "model_prices" (
  "model",
  "input_cost_per_million_usd",
  "output_cost_per_million_usd",
  "cache_read_cost_per_million_usd",
  "cache_write_cost_per_million_usd"
)
VALUES
  ('gpt-6-sol', 2.00, 10.00, 0.20, 2.50),
  ('gpt-6.2-sol', 2.00, 10.00, 0.10, 2.50),
  ('gpt-6.2-astra', 8.00, 40.00, 0.40, 10.00)
ON CONFLICT ("model") DO NOTHING;
