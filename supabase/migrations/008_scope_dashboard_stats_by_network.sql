-- 008_scope_dashboard_stats_by_network.sql
-- Scope the public dashboard aggregation view by network so testnet dummy
-- USDC never mixes with mainnet real USDC in the reported totals.

DROP VIEW IF EXISTS public_dashboard_stats;

CREATE VIEW public_dashboard_stats AS
SELECT
  network,
  COUNT(*) FILTER (WHERE status = 'open') AS active_sessions,
  COALESCE(SUM(voucher_count) FILTER (WHERE status = 'open'), 0) AS open_vouchers,
  COALESCE(SUM(cumulative_amount) FILTER (WHERE status = 'closed'), 0)::text AS total_settled
FROM sessions
GROUP BY network;

COMMENT ON VIEW public_dashboard_stats IS
  'Per-network dashboard aggregation. One row per network; totals are isolated by network.';
