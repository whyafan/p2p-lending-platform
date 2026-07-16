# NexusFi P2P Lending Platform — Memory Index

- [Supabase as primary database](project_supabase_primary_db.md) — Prisma removed; Supabase PostgreSQL is the sole DB. Two one-time setup steps required (service role key + SQL migration).
- [Borrower layer implementation](project_borrower_layers.md) — Three-layer borrower architecture: personas (Layer 1), XAI risk engine (Layer 2), page.tsx integration with effectiveTier pattern
- [Layer 1 design decisions](layer1_design_decisions.md) — Charlie mixer flag deliberate deviation, unscored features (Phase 2), testnetWallet field, test runner setup
- [Dashboard build](project_dashboard_build.md) — Role selection in onboarding (5 steps), LoanRequestPanel 4-step wizard, full borrower dashboard with role toggle, stats, market rates. Needs 002_user_role.sql migration + Sepolia contract deploy to go live.
