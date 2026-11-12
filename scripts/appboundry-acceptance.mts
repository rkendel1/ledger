/**
 * Ledger on AppBoundry's own host (rkendel1/appboundry packages/appboundry-host), in production mode,
 * over HTTP: the evidence for GAP-REGISTER G-05 beyond FeltKit's reference host.
 *
 *   npx feltkit build --target appboundry                                  # ledger.app
 *   (cd <appboundry>/packages/appboundry-host && pnpm run build)            # dist/
 *   APPBOUNDRY_HOST=<appboundry>/packages/appboundry-host/dist/index.js npx tsx scripts/appboundry-acceptance.mts ledger.app
 *
 * Ledger declares built-in accounts (auth.accounts), which AppBoundry does not serve: the operator
 * accepts operator-issued sessions (--accounts operator-sessions). Organizations run through tenancy@1.
 * Prints one line per check and exits non-zero on the first failure.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

// The host package from an AppBoundry checkout (Ledger does not depend on it).
const hostModule = process.env.APPBOUNDRY_HOST;
if (!hostModule) throw new Error("Set APPBOUNDRY_HOST to <appboundry>/packages/appboundry-host/dist/index.js");
const { ArtifactHost, loadArtifact, serve } = (await import(hostModule)) as typeof import("@appport/appboundry-host");

const path = process.argv[2];
if (!path) throw new Error("usage: appboundry-acceptance.mts <path to ledger.app>");
const work = await mkdtemp(join(tmpdir(), "ledger-appboundry-"));
const host = await ArtifactHost.open({ artifact: await loadArtifact(path), stateDir: join(work, "state"), environment: "production", jobIntervalMs: 0, acceptOperatorSessions: true });
const server = await serve(host, { port: 0 });
const ok = (what: string) => console.log(`ok  ${what}`);
try {
  ok(`loaded ${host.artifact.manifest.application.id}; interfaces ${Object.keys(host.artifact.manifest.runtime.interfaces).join(", ")}`);
  const local = { kind: "local" as const, name: "acceptance" };
  const ops = { kind: "operator" as const, id: "ops" };
  const operator = (await host.admin((a) => a.bootstrap(local, { operator: "ops" }))).token;
  for (const id of ["ada", "grace", "gus", "agentbot"]) await host.admin((a) => a.addUser(ops, { id, roles: ["person"], name: id, ...(id === "agentbot" ? { type: "agent" } : {}) }));
  const token = async (user: string) => (await host.admin((a) => a.issueSession(ops, { user }))).token;
  const http = async (tok: string | null, method: string, p: string, body?: unknown) => {
    const r = await fetch(`${server.url}${p}`, { method, headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const call = async (tok: string, kind: "query" | "mutation", name: string, args: Record<string, unknown> = {}) => {
    const r = await http(tok, "POST", `/api/${kind}/${encodeURIComponent(name)}`, { args });
    if (r.status !== 200) throw Object.assign(new Error(`${name}: ${JSON.stringify(r.body.error)}`), { code: r.body.error?.code });
    return r.body.value;
  };
  const provision = async (body: Record<string, unknown>) => {
    const r = await http(operator, "POST", "/_appboundry/admin/tenants.provision", body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.value;
  };

  const ada = await token("ada");
  const created = await http(ada, "POST", "/api/tenants", { name: "Acme" });
  assert.equal(created.status, 201);
  const acme = created.body.tenant.id as string;
  ok("a person creates an organization over HTTP and works in it (owner)");
  await provision({ tenant: acme, user: "grace", role: "bookkeeper" });
  await provision({ tenant: acme, user: "agentbot", role: "assistant" });
  await provision({ name: "Globex", user: "gus", role: "owner" });
  ok("the operator provisions a bookkeeper, an agent member, and a second organization");
  const grace = await token("grace");
  await http(grace, "POST", "/api/tenants/switch", { tenantId: acme });
  const gus = await token("gus");
  const gusTenants = (await http(gus, "GET", "/api/tenants")).body.tenants;
  await http(gus, "POST", "/api/tenants/switch", { tenantId: gusTenants[0].id });

  await call(ada, "mutation", "org:setup", { legalName: "Acme LLC", baseCurrency: "USD", fiscalYearStartMonth: 1, salesTaxRateBp: 800 });
  await call(gus, "mutation", "org:setup", { legalName: "Globex Inc", baseCurrency: "USD", fiscalYearStartMonth: 1 });
  const acct = Object.fromEntries(((await call(ada, "query", "accounts:list")) as Array<{ number: string; id: string }>).map((a) => [a.number, a.id]));
  ok("both organizations set up their books (default chart of accounts)");

  const customer = await call(grace, "mutation", "contacts:create", { kind: "customer", name: "Northwind" });
  const inv = await call(grace, "mutation", "invoices:create", { customerId: customer, issueDate: "2026-03-01", lines: [{ description: "Work", quantityMilli: 1000, unitPriceMinor: 100000, accountId: acct["4000"] }] });
  await call(grace, "mutation", "invoices:issue", { id: inv });
  await call(grace, "mutation", "payments:receive", { customerId: customer, date: "2026-03-05", amountMinor: 100000, accountId: acct["1010"], applyTo: [{ documentId: inv, amountMinor: 100000 }] });
  ok("the bookkeeper issues an invoice and records its payment");

  const exp = await call(grace, "mutation", "expenses:create", { date: "2026-03-02", description: "Lunch", amountMinor: 2500, expenseAccountId: acct["6200"], paidFromAccountId: acct["1010"] });
  const receipt = await call(grace, "mutation", "expenses:upload", { subjectType: "expense", subjectId: exp, name: "r.txt", contentBase64: Buffer.from("receipt").toString("base64") });
  const back = await call(ada, "query", "expenses:readReceipt", { receiptId: receipt });
  assert.equal(Buffer.from(back.contentBase64, "base64").toString(), "receipt");
  await assert.rejects(call(gus, "query", "expenses:readReceipt", { receiptId: receipt }), { code: "NOT_FOUND" });
  ok("a receipt is stored and read back in Acme; Globex gets NOT_FOUND");

  await call(grace, "mutation", "contacts:create", { kind: "vendor", name: "Staples", defaultAccountId: acct["6300"] });
  const bank = await call(ada, "mutation", "banking:createAccount", { name: "Checking", accountId: acct["1010"] });
  await call(grace, "mutation", "banking:importStatement", { bankAccountId: bank, fileName: "q1.csv", csv: "Date,Description,Amount\n2026-03-09,STAPLES STORE 22,-48.10\n" });
  assert.equal(((await call(ada, "query", "review:list", { status: "pending" })) as unknown[]).length, 0);
  await host.runDueJobs();
  const pending = (await call(ada, "query", "review:list", { status: "pending" })) as Array<{ source: string }>;
  assert.deepEqual(pending.map((p) => p.source), ["rules:vendor"]);
  assert.equal(((await call(gus, "query", "review:list", { status: "pending" })) as unknown[]).length, 0);
  ok("an import queues the review scan; the background job proposes in Acme only");

  const agent = await token("agentbot");
  await http(agent, "POST", "/api/tenants/switch", { tenantId: acme });
  assert.ok((await call(agent, "query", "reports:trialBalance")).balanced);
  await assert.rejects(call(agent, "mutation", "invoices:issue", { id: inv }), { code: "FORBIDDEN" });
  ok("the agent member reads reports and cannot execute a financial action");

  const tb = await call(ada, "query", "reports:trialBalance");
  assert.ok(tb.balanced);
  const integrity = await call(ada, "query", "integrity:check");
  assert.deepEqual(integrity.problems, []);
  assert.equal(((await call(gus, "query", "invoices:list")) as unknown[]).length, 0);
  ok("trial balance balances, integrity check is clean, Globex sees no Acme invoice");

  assert.equal((await http(ada, "POST", "/api/tenants/current/members/remove", { principalId: "grace" })).status, 200);
  await assert.rejects(call(grace, "query", "invoices:list"), (e: { code: string }) => ["FORBIDDEN", "FAILED_PRECONDITION"].includes(e.code));
  ok("a removed bookkeeper loses the organization on the next request");
  console.log("all checks passed");
} finally {
  await server.close();
  await host.close();
  await rm(work, { recursive: true, force: true });
}
