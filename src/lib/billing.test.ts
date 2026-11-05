import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { join } from "node:path";
import { setTestEnv, type AppEnv } from "./db";

const WEBHOOK_SECRET = "whsec_test";
const STRIPE = "https://stripe.example.com/v1";

const database = new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys = ON");
for (const file of readdirSync("migrations")
  .filter((name) => name.endsWith(".sql"))
  .sort()) {
  database.exec(readFileSync(join("migrations", file), "utf8"));
}

type Param = string | number | null;

function fakeD1(db: DatabaseSync) {
  const bound = (sql: string, params: Param[]) => {
    const stmt = db.prepare(sql);
    return {
      async first<T>() {
        return (stmt.get(...params) as T | undefined) ?? null;
      },
      async all<T>() {
        return { results: stmt.all(...params) as T[] };
      },
      async run() {
        return { meta: { changes: Number(stmt.run(...params).changes) } };
      },
    };
  };
  return {
    prepare: (sql: string) => ({ bind: (...params: Param[]) => bound(sql, params) }),
    // D1 runs a batch as one transaction.
    async batch(statements: ReturnType<typeof bound>[]) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        db.exec("COMMIT");
        return results;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

setTestEnv({
  DB: fakeD1(database) as unknown as AppEnv["DB"],
  STRIPE_SECRET_KEY: "sk_test",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_PLUS: "price_plus",
  STRIPE_PRICE_PRO: "price_pro",
  STRIPE_API_BASE: STRIPE,
});

const { createCheckout, getBilling, handleEvent, PlanRequiredError, verifyWebhook } = await import("./billing");
const { assertStorageAvailable, storageUsage } = await import("./storage");
const { acceptInvite, createInvite, createTeam } = await import("./teams");
const { GB } = await import("./plans");

// ---------------------------------------------------------------- a fake Stripe

interface Sub {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  metadata?: Record<string, string>;
  items: { data: { price: { id: string }; current_period_end?: number }[] };
}

const subs = new Map<string, Sub>();
const requests: { method: string; path: string; body: string; idempotencyKey: string | null }[] = [];
const originalFetch = globalThis.fetch;

function sub(id: string, customer: string, status: string, price = "price_plus", end = 1_900_000_000): Sub {
  return {
    id,
    customer,
    status,
    cancel_at_period_end: false,
    items: { data: [{ price: { id: price }, current_period_end: end }] },
  };
}

beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1/, "");
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    requests.push({ method, path, body: String(init?.body ?? ""), idempotencyKey: headers.get("idempotency-key") });
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    if (method === "POST" && path === "/customers") return json({ id: `cus_${requests.length}` });
    if (method === "POST" && path === "/checkout/sessions") return json({ url: "https://checkout.example/s" });
    const found = path.match(/^\/subscriptions\/(.+)$/);
    if (method === "GET" && found) {
      const s = subs.get(decodeURIComponent(found[1]));
      return s ? json(s) : json({ error: { message: "No such subscription" } }, 404);
    }
    return json({ error: { message: `unexpected ${method} ${path}` } }, 500);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  requests.length = 0;
  subs.clear();
  for (const table of ["team_invites", "team_members", "teams", "assets", "users"])
    database.exec(`DELETE FROM ${table}`);
});

function user(id: string, fields: Record<string, string | number | null> = {}) {
  database
    .prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)")
    .run(id, `${id}@example.test`, id, 1);
  for (const [k, v] of Object.entries(fields)) database.prepare(`UPDATE users SET ${k} = ? WHERE id = ?`).run(v, id);
  return { id, email: `${id}@example.test`, name: id };
}

const subscriptionEvent = (s: Sub) => ({
  id: "evt_1",
  type: "customer.subscription.updated",
  data: { object: { id: s.id, object: "subscription" } },
});

// ---------------------------------------------------------------- tests

describe("verifyWebhook", () => {
  const payload = JSON.stringify({ id: "evt_1" });
  const sign = (t: number, secret = WEBHOOK_SECRET) =>
    `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
  const now = () => Math.floor(Date.now() / 1000);

  it("accepts Stripe's signature", async () => {
    assert.equal(await verifyWebhook(payload, sign(now())), true);
  });

  it("rejects another secret, an old timestamp, a changed body and no header", async () => {
    assert.equal(await verifyWebhook(payload, sign(now(), "whsec_other")), false);
    assert.equal(await verifyWebhook(payload, sign(now() - 600)), false);
    assert.equal(await verifyWebhook(`${payload} `, sign(now())), false);
    assert.equal(await verifyWebhook(payload, null), false);
  });
});

describe("subscriptions", () => {
  it("checkout completing puts the user on the plan", async () => {
    user("u1", { stripe_customer_id: "cus_1" });
    subs.set("sub_1", sub("sub_1", "cus_1", "active", "price_plus"));
    await handleEvent({
      id: "evt_1",
      type: "checkout.session.completed",
      data: { object: { id: "cs_1", object: "checkout.session", subscription: "sub_1" } },
    });
    const billing = await getBilling("u1");
    assert.equal(billing.plan, "plus");
    assert.equal(billing.renewsAt, 1_900_000_000_000);
    assert.equal((await storageUsage("u1")).quotaBytes, 5 * GB);
  });

  it("keeps the plan while a payment is past due, and drops to Free when it ends", async () => {
    user("u1", { stripe_customer_id: "cus_1" });
    subs.set("sub_1", sub("sub_1", "cus_1", "past_due", "price_pro"));
    await handleEvent(subscriptionEvent(subs.get("sub_1")!));
    assert.equal((await getBilling("u1")).plan, "pro");
    subs.set("sub_1", sub("sub_1", "cus_1", "canceled", "price_pro"));
    await handleEvent(subscriptionEvent(subs.get("sub_1")!));
    assert.equal((await getBilling("u1")).plan, "free");
  });

  it("an old subscription ending doesn't touch the current one", async () => {
    user("u1", { stripe_customer_id: "cus_1" });
    subs.set("sub_new", sub("sub_new", "cus_1", "active", "price_pro"));
    await handleEvent(subscriptionEvent(subs.get("sub_new")!));
    subs.set("sub_old", sub("sub_old", "cus_1", "canceled", "price_plus"));
    await handleEvent(subscriptionEvent(subs.get("sub_old")!));
    assert.equal((await getBilling("u1")).plan, "pro");
  });

  it("finds the user from the subscription's metadata before the customer is recorded", async () => {
    user("u1");
    subs.set("sub_1", { ...sub("sub_1", "cus_9", "active", "price_plus"), metadata: { user_id: "u1" } });
    await handleEvent(subscriptionEvent(subs.get("sub_1")!));
    const billing = await getBilling("u1");
    assert.equal(billing.plan, "plus");
    assert.equal(billing.hasCustomer, true);
  });

  it("checkout makes one customer per user and refuses a second subscription", async () => {
    const u = user("u1");
    assert.equal(await createCheckout(u, "plus", "https://app.test"), "https://checkout.example/s");
    const customer = requests.find((r) => r.path === "/customers");
    assert.equal(customer?.idempotencyKey, "customer-u1");
    const session = requests.find((r) => r.path === "/checkout/sessions")!;
    assert.match(decodeURIComponent(session.body), /line_items\[0\]\[price\]=price_plus/);
    assert.match(decodeURIComponent(session.body), /success_url=https:\/\/app.test\/\?billing=success/);

    database
      .prepare("UPDATE users SET stripe_subscription_id = 'sub_1', subscription_status = 'active' WHERE id = 'u1'")
      .run();
    await assert.rejects(createCheckout(u, "pro", "https://app.test"), { status: 409 });
  });
});

describe("storage by plan", () => {
  it("Free is 1 GB, a comp overrides the paid plan, and an unknown plan counts as Free", async () => {
    user("free");
    user("comped", { plan: "plus", plan_override: "pro" });
    user("retired", { plan: "gold" });
    assert.equal((await storageUsage("free")).quotaBytes, 1 * GB);
    assert.equal((await storageUsage("comped")).quotaBytes, 20 * GB);
    assert.equal((await storageUsage("retired")).quotaBytes, 1 * GB);
  });

  it("refuses new files once the plan's storage is full", async () => {
    user("u1");
    database
      .prepare("INSERT INTO assets (user_id, key, bucket, bytes, content_type, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("u1", "videos/a.mp4", "reelfling-media", GB - 10, "video/mp4", 1);
    await assertStorageAvailable("u1", 5);
    await assert.rejects(assertStorageAvailable("u1", 20), /storage is full \(1 GB\)/);
    database.prepare("UPDATE users SET plan = 'plus' WHERE id = 'u1'").run();
    await assertStorageAvailable("u1", 20);
  });
});

describe("teams need a paid plan", () => {
  it("Free can't create a team; Plus can", async () => {
    user("free");
    user("paid", { plan: "plus" });
    await assert.rejects(createTeam("free", "Studio"), (e: unknown) => e instanceof PlanRequiredError);
    assert.equal((await createTeam("paid", "Studio")).role, "owner");
  });

  it("a Free user can join; an owner back on Free can't invite, and open links stop working", async () => {
    user("owner", { plan: "pro" });
    user("joiner");
    user("late");
    const team = await createTeam("owner", "Studio");
    const first = await createInvite(team.id, "owner", "https://app.test");
    const joined = await acceptInvite("joiner", first.url.split("/invite/")[1]);
    assert.equal(joined.members.length, 2);

    const second = await createInvite(team.id, "owner", "https://app.test");
    database.prepare("UPDATE users SET plan = 'free' WHERE id = 'owner'").run();
    await assert.rejects(createInvite(team.id, "owner", "https://app.test"), { status: 402 });
    await assert.rejects(acceptInvite("late", second.url.split("/invite/")[1]), /isn't taking new members/);

    database.prepare("UPDATE users SET plan_override = 'plus' WHERE id = 'owner'").run();
    assert.equal((await acceptInvite("late", second.url.split("/invite/")[1])).members.length, 3);
  });
});
