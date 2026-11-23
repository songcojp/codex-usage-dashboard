# Current model price seeds

## Requirement and acceptance

The Model prices base-data page must contain prices for the model IDs found in current local Codex sessions: `gpt-6-sol`, `gpt-6-astra`, `gpt-6.2-sol`, and `gpt-6.2-astra`. The four rates for each model use published OpenAI API Standard, short-context text pricing and the default 30-minute cache-write rate, in USD per million tokens. Existing administrator-entered prices must survive an upgrade. The migration must be packaged with the server and run exactly once by the existing migration runner. Current `main` already seeds `gpt-6-astra` in `0009_seed_gpt_6_astra_price.sql`; this change adds the other three models.

## Existing path

`0001_initial.sql` seeds GPT-5.6 prices. Later migrations through `0009` add other models, including GPT-6 Astra. The admin API lists `model_prices` rows directly; it does not infer a price from usage events. Ingestion resolves the exact model name and persists calculated event cost. The migration runner checks checksums, so editing an applied migration would break existing installations.

## Boundary and proposal

Add an append-only `0010` SQL migration containing the three observed model names absent from current `main`. Insert on model-name conflict with `DO NOTHING` so operator prices win. Leave existing price rows, the pricing schema, and the admin API unchanged. Add a focused baseline test and a README note. This updates base data for future ingestion after deployment; it does not recalculate costs already stored in `usage_events` or `daily_usage_rollups`.

The rates were checked on 2026-11-23 against the official [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol), [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [GPT-6.2 Sol](https://developers.openai.com/api/docs/models/gpt-6.2-sol), and [GPT-6.2 Astra](https://developers.openai.com/api/docs/models/gpt-6.2-astra) model pages. They are API reference rates, not a claim about what a Codex subscription was billed. Long-context, 12-hour cache retention, processing tier, and regional pricing can differ; the current four-column price table cannot represent those variations.

## Alternatives, risk, and rollback

Editing `0001` was rejected because applied checksums are immutable. Overwriting existing rows was rejected because it would discard administrator settings. The additive migration can be rolled back by deleting only its new rows, after checking whether an administrator edited them. Existing usage totals need a separate explicit recalculation if historical costs are required.

## Verification and stages

One stage: add the migration and documentation, run the server schema test, typecheck, and build. Inspect the packaged SQL. On a deployment, run the normal migration, then verify `/api/admin/model-prices` as an authenticated administrator and check that custom prices remain unchanged. Deployment is outside this change.

## Review record

Round 1, data and contract lens: checked all four rate tuples against the official model pages and confirmed `ON CONFLICT` preserves operator values. The first schema test only mirrored the SQL text, so it was removed; the migration was instead executed twice against isolated PostgreSQL with a preexisting custom rate.

Round 2, operational and rollback lens: found that `docs/superpowers/` is ignored and moved this document to tracked `docs/`. Confirmed the initial migration remains unchanged, server build packages the new SQL, and already-persisted event costs are outside the stated scope. No open P0-P2 design findings.

Round 3, base-currency lens: current `main` added migrations `0005` through `0009`, including GPT-6 Astra. Renumbered this migration to `0010` and removed the already-seeded Astra row. The remaining three prices and the no-overwrite contract are unchanged.
