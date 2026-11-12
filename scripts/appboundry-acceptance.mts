/**
 * Ledger on AppBoundry, the way an operator runs it: the published `appboundry` CLI
 * (`@appport/appboundry`, a dev dependency) runs `ledger.app` in production mode, an operator
 * bootstraps, adds people, issues sessions and provisions organizations with `appboundry admin`, and
 * everything else goes over HTTP. Evidence for GAP-REGISTER G-05.
 *
 *   npm run test:appboundry      # builds ledger.app, then runs this
 *
 * Ledger declares built-in accounts (auth.accounts), which AppBoundry does not serve, so the runtime
 * is started with --accounts operator-sessions. Organizations run through tenancy@1. Background jobs
 * run on the runtime's own worker. Prints one line per check; exits non-zero on the first failure.
 */
import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const artifact = resolve(process.argv[2] ?? "ledger.app");
const bin = resolve("node_modules/.bin/appboundry");
const run = promisify(execFile);
const ok = (what: string) => console.log(`ok  ${what}`);

const freePort = () => new Promise<number>((done) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address() as { port: number };
    s.close(() => done(port));
  });
});

// A local state directory, whatever FeltDB this shell is configured for (the runtime refuses the ambiguity).
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("FELTDB_")));

const work = await mkdtemp(join(tmpdir(), "ledger-appboundry-"));
const state = join(work, "state");
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const runtime = spawn(bin, ["run", artifact, "--state", state, "--environment", "production", "--port", String(port), "--feltdb", "local", "--accounts", "operator-sessions"], { stdio: ["ignore", "pipe", "pipe"], env });
let output = "";
runtime.stdout.on("data", (d) => (output += d));
runtime.stderr.on("data", (d) => (output += d));

/** `appboundry admin …` against the running runtime (its local socket), as the operator account. */
const admin = async (...args: string[]) => {
  const { stdout } = await run(bin, ["admin", ...args, "--state", state, "--json"], { env });
  return JSON.parse(stdout);
};

try {
  for (let i = 0; ; i++) {
    if (runtime.exitCode !== null) throw new Error(`the runtime exited:\n${output}`);
    const up = await fetch(`${base}/_appboundry/health`).then((r) => r.ok, () => false);
    if (up) break;
    if (i > 300) throw new Error(`the runtime did not become healthy:\n${output}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  ok(`appboundry run ledger.app (production, operator sessions) is healthy on ${base}`);

  await admin("bootstrap", "--operator", "ops");
  for (const id of ["ada", "grace", "gus"]) await admin("users", "add", id, "--role", "person", "--name", id);
  await admin("users", "add", "agentbot", "--role", "person", "--type", "agent");
  const token = async (user: string) => (await admin("sessions", "issue", "--user", user)).token as string;
  ok("the operator bootstrapped, added people and an agent, and issues their sessions");

  const http = async (tok: string | null, method: string, p: string, body?: unknown) => {
    const r = await fetch(`${base}${p}`, { method, headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const call = async (tok: string, kind: "query" | "mutation", name: string, args: Record<string, unknown> = {}) => {
    const r = await http(tok, "POST", `/api/${kind}/${encodeURIComponent(name)}`, { args });
    if (r.status !== 200) throw Object.assign(new Error(`${name}: ${JSON.stringify(r.body.error)}`), { code: r.body.error?.code });
    return r.body.value;
  };

  const ada = await token("ada");
  const created = await http(ada, "POST", "/api/tenants", { name: "Acme" });
  assert.equal(created.status, 201);
  const acme = created.body.tenant.id as string;
  ok("a person creates an organization over HTTP and works in it (owner)");
  await admin("tenants", "provision", "--tenant", acme, "--user", "grace", "--role", "bookkeeper");
  await admin("tenants", "provision", "--tenant", acme, "--user", "agentbot", "--role", "assistant");
  const globex = (await admin("tenants", "provision", "--name", "Globex", "--user", "gus", "--role", "owner")).tenant.id as string;
  ok("`appboundry admin tenants provision` adds a bookkeeper, an agent member, and a second organization");
  const grace = await token("grace");
  await http(grace, "POST", "/api/tenants/switch", { tenantId: acme });
  const gus = await token("gus");
  await http(gus, "POST", "/api/tenants/switch", { tenantId: globex });

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
  let pending: Array<{ source: string }> = [];
  for (let i = 0; i < 100 && pending.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 200));
    pending = await call(ada, "query", "review:list", { status: "pending" });
  }
  assert.deepEqual(pending.map((p) => p.source), ["rules:vendor"]);
  assert.equal(((await call(gus, "query", "review:list", { status: "pending" })) as unknown[]).length, 0);
  ok("an import queues the review scan; the runtime's job worker proposes in Acme only");

  const agent = await token("agentbot");
  await http(agent, "POST", "/api/tenants/switch", { tenantId: acme });
  assert.ok((await call(agent, "query", "reports:trialBalance")).balanced);
  await assert.rejects(call(agent, "mutation", "invoices:issue", { id: inv }), { code: "FORBIDDEN" });
  ok("the agent member reads reports and cannot execute a financial action");

  assert.ok((await call(ada, "query", "reports:trialBalance")).balanced);
  assert.deepEqual((await call(ada, "query", "integrity:check")).problems, []);
  assert.equal(((await call(gus, "query", "invoices:list")) as unknown[]).length, 0);
  ok("trial balance balances, integrity check is clean, Globex sees no Acme invoice");

  assert.equal((await http(ada, "POST", "/api/tenants/current/members/remove", { principalId: "grace" })).status, 200);
  await assert.rejects(call(grace, "query", "invoices:list"), (e: { code: string }) => ["FORBIDDEN", "FAILED_PRECONDITION"].includes(e.code));
  ok("a removed bookkeeper loses the organization on the next request");
  console.log("all checks passed");
} finally {
  if (runtime.exitCode === null) {
    const exited = new Promise((r) => runtime.once("exit", r));
    runtime.kill("SIGTERM");
    await exited;
  }
  await rm(work, { recursive: true, force: true });
}
