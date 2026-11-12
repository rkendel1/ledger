/**
 * Ledger: small-business double-entry accounting on FeltKit.
 *
 * One FeltDB instance per deployment holds every organization's books. Each organization is a
 * FeltKit tenant (`auth.tenant`), and every financial collection is `{ tenant: true }`: FeltKit
 * stamps the caller's live organization on inserts and limits every read and write to it. An
 * organization id is never taken from a request.
 *
 * Money is always an integer number of minor units (cents). Dates are ISO calendar dates
 * (YYYY-MM-DD) in the organization's books, compared as strings.
 *
 * The ledger is authoritative: `journalEntries` (headers) and `ledgerLines` (the posted debit and
 * credit lines). Every report is computed from posted `ledgerLines`; drafts hold their lines on the
 * draft header and never reach `ledgerLines`, so a draft cannot affect a report by construction.
 */
import { feltkit, s } from "@feltdb/feltkit";

/** Read permissions every member of an organization holds. */
const READ = [
  "org.read", "accounts.read", "journal.read", "periods.read", "contacts.read", "invoices.read",
  "bills.read", "expenses.read", "banking.read", "reports.read", "audit.read", "proposals.read",
  "files.read", "notifications.read", "notifications.update",
];

/** Day-to-day bookkeeping: records activity, but cannot post manual journals, approve, or close. */
const BOOKKEEPING = [
  ...READ,
  "contacts.write", "invoices.write", "invoices.issue", "payments.record",
  "bills.write", "bills.post", "expenses.write", "banking.import", "banking.categorize",
  "banking.match", "journal.draft", "proposals.create", "proposals.decide", "files.write",
  "notifications.send",
];

/** An accountant: everything financial, including posting, reversing, approving and closing periods. */
const ACCOUNTING = [
  ...BOOKKEEPING,
  "accounts.write", "journal.post", "journal.reverse", "invoices.void", "bills.approve",
  "expenses.approve", "banking.reconcile", "periods.close", "periods.reopen",
];

export const ROLES = ["owner", "admin", "accountant", "bookkeeper", "reviewer", "assistant"] as const;
export type Role = (typeof ROLES)[number];

export const app = feltkit({
  name: "ledger",
  description: "Small-business double-entry accounting: invoices, bills, expenses, banking, reconciliation and reports.",
  roles: {
    // Every account holds this outside an organization: nothing.
    person: [],
    owner: [...ACCOUNTING, "org.manage", "tenant.*"],
    admin: [...ACCOUNTING, "org.manage", "tenant.members.manage"],
    accountant: ACCOUNTING,
    bookkeeper: BOOKKEEPING,
    reviewer: READ,
    // An agent member: reads the books and proposes. It cannot execute any financial action;
    // those functions are also `approval: "required"`, which FeltKit enforces for non-person callers.
    assistant: [...READ.filter((p) => !p.startsWith("files.") && !p.startsWith("notifications.")), "proposals.create"],
  },
  auth: {
    accounts: { roles: ["person"] },
    tenant: {
      name: "organization",
      roles: ROLES,
      create: "anyone",
    },
  },
  dev: {
    users: [
      { id: "ada", name: "Ada (owner)", roles: ["person"] },
      { id: "grace", name: "Grace (bookkeeper)", roles: ["person"] },
    ],
  },
  services: {
    files: true,
    // In-app notices to approvers (bills awaiting approval, expenses to review). Read from the inbox.
    notifications: { types: ["bill.awaiting_approval", "expense.submitted"] },
  },
});

const money = () => s.integer();
/**
 * Every tenant-scoped collection declares its tenant field (as FeltKit would add it: optional) so
 * unique constraints and indexes can name it. A unique constraint that omitted it would be enforced
 * across all organizations.
 */
const TENANT = { tenantId: s.optional(s.string()) };
const date = () => s.string({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });

export const ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "expense"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export const ACCOUNT_SUBTYPES = [
  "cash", "bank", "receivable", "other_current_asset", "fixed_asset",
  "payable", "credit_card", "tax_payable", "other_current_liability", "long_term_liability",
  "equity", "retained_earnings", "opening_balance",
  "revenue", "other_income",
  "cost_of_sales", "expense",
] as const;
export type AccountSubtype = (typeof ACCOUNT_SUBTYPES)[number];

/** One record per organization: identity, currency, fiscal year and the closed-period boundary. */
export const orgSettings = app.collection(
  "orgSettings",
  {
    ...TENANT,
    legalName: s.string({ minLength: 1, maxLength: 200 }),
    displayName: s.string({ minLength: 1, maxLength: 120 }),
    baseCurrency: s.string({ pattern: "^[A-Z]{3}$" }),
    /** 1–12: the month the fiscal year starts. */
    fiscalYearStartMonth: s.integer({ minimum: 1, maximum: 12 }),
    /** Books are closed through this date (inclusive). "" when nothing is closed. */
    closedThrough: s.string(),
    createdAt: s.number(),
    createdBy: s.string(),
  },
  { tenant: true, unique: [["tenantId"]] },
);

export const accounts = app.collection(
  "accounts",
  {
    ...TENANT,
    number: s.string({ pattern: "^[0-9]{3,8}$" }),
    name: s.string({ minLength: 1, maxLength: 120 }),
    type: s.enum(ACCOUNT_TYPES),
    subtype: s.enum(ACCOUNT_SUBTYPES),
    parentId: s.optional(s.string()),
    description: s.optional(s.string({ maxLength: 500 })),
    active: s.boolean(),
    /** Accounts the workflows post to (receivable, payable, tax, equity). Cannot be deactivated. */
    system: s.boolean(),
    createdAt: s.number(),
  },
  { tenant: true, unique: [["tenantId", "number"]], indexes: [{ fields: ["tenantId", "type"] }] },
);

export const SOURCE_TYPES = [
  "manual", "opening_balance", "reversal", "invoice", "credit_note", "payment_received",
  "bill", "payment_made", "expense", "bank", "proposal",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

const line = s.object({
  accountId: s.string(),
  debit: money(),
  credit: money(),
  memo: s.optional(s.string({ maxLength: 300 })),
  contactId: s.optional(s.string()),
});

/**
 * Journal entry headers. A draft carries its proposed lines in `draftLines`; posting moves them to
 * `ledgerLines` and the header becomes immutable. Corrections are new entries (`reversalOf`).
 */
export const journalEntries = app.collection(
  "journalEntries",
  {
    ...TENANT,
    /** Assigned at posting from a per-organization gapless sequence; 0 while a draft. */
    number: s.integer(),
    status: s.enum(["draft", "posted"] as const),
    date: date(),
    description: s.string({ minLength: 1, maxLength: 300 }),
    reference: s.optional(s.string({ maxLength: 120 })),
    sourceType: s.enum(SOURCE_TYPES),
    sourceId: s.optional(s.string()),
    draftLines: s.optional(s.array(line)),
    totalMinor: money(),
    reversalOf: s.optional(s.string()),
    reason: s.optional(s.string({ maxLength: 500 })),
    createdBy: s.string(),
    createdAt: s.number(),
    postedBy: s.optional(s.string()),
    postedAt: s.optional(s.number()),
    /** When an approved proposal caused the posting: the proposal and who approved it. */
    proposalId: s.optional(s.string()),
    approvedBy: s.optional(s.string()),
    idempotencyKey: s.optional(s.string({ maxLength: 120 })),
  },
  {
    tenant: true,
    unique: [{ fields: ["tenantId", "idempotencyKey"], sparse: true }, { fields: ["tenantId", "reversalOf"], sparse: true }],
    indexes: [{ fields: ["tenantId", "status"] }, { fields: ["tenantId", "sourceType", "sourceId"] }],
  },
);

/** Posted debit/credit lines: the ledger. Written once, in the posting transaction, never changed. */
export const ledgerLines = app.collection(
  "ledgerLines",
  {
    ...TENANT,
    entryId: s.string(),
    entryNumber: s.integer(),
    lineNo: s.integer(),
    date: date(),
    accountId: s.string(),
    debit: money(),
    credit: money(),
    memo: s.optional(s.string()),
    contactId: s.optional(s.string()),
    sourceType: s.enum(SOURCE_TYPES),
  },
  { tenant: true, indexes: [{ fields: ["tenantId", "accountId"] }, { fields: ["tenantId", "entryId"] }] },
);

/** Append-only record of period closes and reopens. `orgSettings.closedThrough` is the current value. */
export const periodEvents = app.collection(
  "periodEvents",
  {
    ...TENANT,
    action: s.enum(["close", "reopen"] as const),
    closedThrough: s.string(),
    previous: s.string(),
    reason: s.optional(s.string({ maxLength: 500 })),
    by: s.string(),
    at: s.number(),
  },
  { tenant: true },
);

export const contacts = app.collection(
  "contacts",
  {
    ...TENANT,
    kind: s.enum(["customer", "vendor"] as const),
    name: s.string({ minLength: 1, maxLength: 200 }),
    email: s.optional(s.string({ maxLength: 200 })),
    phone: s.optional(s.string({ maxLength: 50 })),
    address: s.optional(s.string({ maxLength: 500 })),
    /** Vendors: the expense account their bills and bank transactions usually belong to. */
    defaultAccountId: s.optional(s.string()),
    paymentTermsDays: s.integer({ minimum: 0, maximum: 365 }),
    active: s.boolean(),
    createdAt: s.number(),
  },
  { tenant: true, unique: [["tenantId", "kind", "name"]], search: ["name", "email"] },
);

export const taxRates = app.collection(
  "taxRates",
  {
    ...TENANT,
    name: s.string({ minLength: 1, maxLength: 80 }),
    /** Basis points: 825 = 8.25%. */
    rateBp: s.integer({ minimum: 0, maximum: 10000 }),
    accountId: s.string(),
    active: s.boolean(),
  },
  { tenant: true, unique: [["tenantId", "name"]] },
);

const invoiceLine = s.object({
  description: s.string({ minLength: 1, maxLength: 300 }),
  /** Thousandths of a unit: 1500 = 1.5 hours. */
  quantityMilli: s.integer({ minimum: 1 }),
  unitPriceMinor: s.integer({ minimum: 0 }),
  accountId: s.string(),
  taxRateId: s.optional(s.string()),
  amountMinor: money(),
  taxMinor: money(),
});

export const invoices = app.collection(
  "invoices",
  {
    ...TENANT,
    /** Assigned at issue from a gapless per-organization sequence ("INV-0001"); absent on drafts. */
    number: s.optional(s.string()),
    customerId: s.string(),
    issueDate: date(),
    dueDate: date(),
    /** draft → issued → (void). Paid / partially paid / overdue are derived from allocations and dates. */
    status: s.enum(["draft", "issued", "void"] as const),
    lines: s.array(invoiceLine, { minItems: 1 }),
    subtotalMinor: money(),
    taxMinor: money(),
    totalMinor: money(),
    memo: s.optional(s.string({ maxLength: 1000 })),
    journalEntryId: s.optional(s.string()),
    voidEntryId: s.optional(s.string()),
    createdBy: s.string(),
    createdAt: s.number(),
    issuedBy: s.optional(s.string()),
  },
  { tenant: true, unique: [{ fields: ["tenantId", "number"], sparse: true }], indexes: [{ fields: ["tenantId", "customerId"] }] },
);

export const creditNotes = app.collection(
  "creditNotes",
  {
    ...TENANT,
    number: s.string(),
    invoiceId: s.string(),
    customerId: s.string(),
    date: date(),
    reason: s.string({ minLength: 1, maxLength: 500 }),
    lines: s.array(s.object({ description: s.string(), accountId: s.string(), amountMinor: money(), taxMinor: money() }), { minItems: 1 }),
    totalMinor: money(),
    journalEntryId: s.string(),
    createdBy: s.string(),
    createdAt: s.number(),
  },
  { tenant: true, unique: [["tenantId", "number"]] },
);

export const bills = app.collection(
  "bills",
  {
    ...TENANT,
    vendorId: s.string(),
    /** The vendor's own invoice number. Unique per vendor, so a bill cannot be entered twice. */
    billNumber: s.string({ minLength: 1, maxLength: 80 }),
    billDate: date(),
    dueDate: date(),
    status: s.enum(["draft", "approved", "posted", "void"] as const),
    lines: s.array(s.object({ description: s.string({ minLength: 1 }), accountId: s.string(), amountMinor: s.integer({ minimum: 1 }) }), { minItems: 1 }),
    totalMinor: money(),
    memo: s.optional(s.string({ maxLength: 1000 })),
    approvedBy: s.optional(s.string()),
    approvedAt: s.optional(s.number()),
    journalEntryId: s.optional(s.string()),
    voidEntryId: s.optional(s.string()),
    createdBy: s.string(),
    createdAt: s.number(),
  },
  { tenant: true, unique: [["tenantId", "vendorId", "billNumber"]] },
);

/** Money received from customers or paid to vendors. */
export const payments = app.collection(
  "payments",
  {
    ...TENANT,
    direction: s.enum(["received", "made"] as const),
    contactId: s.string(),
    date: date(),
    amountMinor: s.integer({ minimum: 1 }),
    /** The cash, bank or credit-card account the money moved through. */
    accountId: s.string(),
    method: s.optional(s.string({ maxLength: 40 })),
    reference: s.optional(s.string({ maxLength: 120 })),
    journalEntryId: s.string(),
    /** What the payment settled when recorded (kept as evidence; live settlement is `allocations`). */
    applied: s.array(s.object({ documentType: s.enum(["invoice", "bill"] as const), documentId: s.string(), amountMinor: s.integer() })),
    idempotencyKey: s.optional(s.string({ maxLength: 120 })),
    voidEntryId: s.optional(s.string()),
    voidReason: s.optional(s.string()),
    createdBy: s.string(),
    createdAt: s.number(),
  },
  { tenant: true, unique: [{ fields: ["tenantId", "idempotencyKey"], sparse: true }] },
);

/** How a payment or credit note settles an invoice or bill. Balances are derived from these. */
export const allocations = app.collection(
  "allocations",
  {
    ...TENANT,
    sourceType: s.enum(["payment", "credit_note"] as const),
    sourceId: s.string(),
    documentType: s.enum(["invoice", "bill"] as const),
    documentId: s.string(),
    amountMinor: s.integer({ minimum: 1 }),
    date: date(),
  },
  { tenant: true, indexes: [{ fields: ["tenantId", "documentId"] }, { fields: ["tenantId", "sourceId"] }] },
);

export const expenses = app.collection(
  "expenses",
  {
    ...TENANT,
    date: date(),
    vendorId: s.optional(s.string()),
    description: s.string({ minLength: 1, maxLength: 300 }),
    amountMinor: s.integer({ minimum: 1 }),
    currency: s.string({ pattern: "^[A-Z]{3}$" }),
    expenseAccountId: s.string(),
    paidFromAccountId: s.string(),
    status: s.enum(["draft", "approved", "rejected"] as const),
    bankTransactionId: s.optional(s.string()),
    journalEntryId: s.optional(s.string()),
    reviewNote: s.optional(s.string({ maxLength: 500 })),
    reviewedBy: s.optional(s.string()),
    createdBy: s.string(),
    createdAt: s.number(),
  },
  { tenant: true },
);

/** A receipt: a Files-service file bound to an expense (or bill) of this organization. */
export const receipts = app.collection(
  "receipts",
  {
    ...TENANT,
    subjectType: s.enum(["expense", "bill"] as const),
    subjectId: s.string(),
    fileId: s.string(),
    name: s.string(),
    contentType: s.optional(s.string()),
    size: s.integer(),
    checksum: s.optional(s.string()),
    uploadedBy: s.string(),
    at: s.number(),
  },
  { tenant: true, unique: [["tenantId", "fileId"]], indexes: [{ fields: ["tenantId", "subjectId"] }] },
);

export const bankAccounts = app.collection(
  "bankAccounts",
  {
    ...TENANT,
    name: s.string({ minLength: 1, maxLength: 120 }),
    /** The ledger account (subtype bank, cash or credit_card) this statement feeds. */
    accountId: s.string(),
    institution: s.optional(s.string({ maxLength: 120 })),
    last4: s.optional(s.string({ pattern: "^[0-9]{4}$" })),
    createdAt: s.number(),
  },
  { tenant: true, unique: [["tenantId", "accountId"]] },
);

/** One imported statement file, kept with its bytes (Files service) and what the import did with every row. */
export const statementImports = app.collection(
  "statementImports",
  {
    ...TENANT,
    bankAccountId: s.string(),
    fileId: s.string(),
    fileName: s.string(),
    sha256: s.string(),
    rowCount: s.integer(),
    importedCount: s.integer(),
    duplicates: s.array(s.object({ row: s.integer(), date: s.string(), amountMinor: s.integer(), description: s.string(), existingId: s.string() })),
    rejected: s.array(s.object({ row: s.integer(), reason: s.string(), raw: s.string() })),
    periodStart: s.string(),
    periodEnd: s.string(),
    importedBy: s.string(),
    at: s.number(),
  },
  { tenant: true, unique: [["tenantId", "bankAccountId", "sha256"]] },
);

export const bankTransactions = app.collection(
  "bankTransactions",
  {
    ...TENANT,
    bankAccountId: s.string(),
    importId: s.string(),
    row: s.integer(),
    date: date(),
    description: s.string(),
    /** Normalized payee text used for duplicate detection and rule matching. */
    payee: s.string(),
    /** Positive: money into the account. Negative: money out. */
    amountMinor: s.integer(),
    /** date|amount|payee|occurrence: identical rows in one statement stay distinct; a re-import collides. */
    fingerprint: s.string(),
    status: s.enum(["unmatched", "matched", "excluded"] as const),
    /** Ledger lines on the bank's account this transaction is matched to (their sum equals the amount). */
    matchedLineIds: s.array(s.string()),
    /** When categorizing created the entry. */
    journalEntryId: s.optional(s.string()),
    excludedReason: s.optional(s.string()),
    reconciliationId: s.optional(s.string()),
    matchedBy: s.optional(s.string()),
  },
  {
    tenant: true,
    unique: [["tenantId", "bankAccountId", "fingerprint"]],
    indexes: [{ fields: ["tenantId", "bankAccountId", "status"] }, { fields: ["tenantId", "importId"] }],
    search: ["description"],
  },
);

/** Which bank transaction a ledger line is cleared by. A line clears at most once. */
export const bankMatches = app.collection(
  "bankMatches",
  {
    ...TENANT, bankTransactionId: s.string(), ledgerLineId: s.string(), bankAccountId: s.string() },
  { tenant: true, unique: [["tenantId", "ledgerLineId"]], indexes: [{ fields: ["tenantId", "bankTransactionId"] }] },
);

export const reconciliations = app.collection(
  "reconciliations",
  {
    ...TENANT,
    bankAccountId: s.string(),
    statementStart: date(),
    statementEnd: date(),
    openingBalanceMinor: s.integer(),
    closingBalanceMinor: s.integer(),
    status: s.enum(["in_progress", "completed"] as const),
    /** Filled at completion: the evidence of what was reconciled. */
    result: s.optional(s.object({
      bankTransactionIds: s.array(s.string()),
      clearedLineIds: s.array(s.string()),
      statementTotalMinor: s.integer(),
      bookBalanceMinor: s.integer(),
      unclearedBookMinor: s.integer(),
      differenceMinor: s.integer(),
    })),
    startedBy: s.string(),
    startedAt: s.number(),
    completedBy: s.optional(s.string()),
    completedAt: s.optional(s.number()),
  },
  { tenant: true, indexes: [{ fields: ["tenantId", "bankAccountId"] }] },
);

export const PROPOSAL_ACTIONS = ["bank.categorize", "bank.match", "journal.post"] as const;
export type ProposalAction = (typeof PROPOSAL_ACTIONS)[number];

/**
 * Proposed financial actions awaiting a person's decision: from Ledger's deterministic rules or from
 * an agent. Approving executes the action in the approver's authority, in the same transaction.
 */
export const proposals = app.collection(
  "proposals",
  {
    ...TENANT,
    action: s.enum(PROPOSAL_ACTIONS),
    input: s.record(s.unknown()),
    summary: s.string({ maxLength: 300 }),
    rationale: s.string({ maxLength: 2000 }),
    /** What the proposer looked at: record ids and the values it relied on. */
    evidence: s.record(s.unknown()),
    /** "rules:<rule>" for Ledger's own rules, or "agent:<principal>". */
    source: s.string(),
    proposedBy: s.string(),
    proposedByType: s.string(),
    /** One open proposal per subject and action (e.g. one categorization per bank transaction). */
    subjectKey: s.string(),
    status: s.enum(["pending", "approved", "rejected", "failed", "superseded"] as const),
    decidedBy: s.optional(s.string()),
    decidedAt: s.optional(s.number()),
    decisionReason: s.optional(s.string({ maxLength: 500 })),
    result: s.optional(s.record(s.unknown())),
    createdAt: s.number(),
  },
  { tenant: true, indexes: [{ fields: ["tenantId", "status"] }, { fields: ["tenantId", "subjectKey"] }] },
);

/**
 * The business audit trail: written in the same transaction as the change it describes, ordered by a
 * FeltDB sequence per subject, linked to FeltKit's activity log by request id.
 */
export const audit = app.auditTrail("audit", {
  subjects: ["org", "account", "journal", "period", "contact", "invoice", "bill", "payment", "expense", "receipt", "bank", "reconciliation", "proposal"] as const,
  tenant: true,
});
