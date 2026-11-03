-- Plans and billing (see plans.ts, billing.ts). Storage belongs to people: every file
-- counts against whoever made it, wherever it lives (see storage.ts).

-- The plan Stripe says the user paid for ('free' when there's no live subscription).
ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
-- Set by hand (comps, staff); wins over `plan`.
ALTER TABLE users ADD COLUMN plan_override TEXT;
ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE users ADD COLUMN subscription_status TEXT;
-- End of the paid period, ms.
ALTER TABLE users ADD COLUMN renews_at INTEGER;
ALTER TABLE users ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX users_by_stripe_customer ON users (stripe_customer_id);

-- Per-person usage sums assets by creator, plus files in workspaces they own.
CREATE INDEX assets_by_creator ON assets (created_by);
CREATE INDEX workspaces_by_owner ON workspaces (owner_id);

-- Teams are a paid feature now. Owners of teams that already exist keep theirs.
UPDATE users SET plan_override = 'pro' WHERE id IN (SELECT owner_id FROM workspaces WHERE kind = 'team');
