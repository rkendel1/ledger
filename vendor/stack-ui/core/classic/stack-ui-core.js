/*! @stack-ui/core 0.9.0 — classic build. Exposes window.StackUI. */
'use strict';
(function (global) {
'use strict';
// ---- states.js
// State semantics (docs/design-system-contract.md §6). Pure data and pure
// functions: no DOM, no network, no storage.
//
// Mappings are keyed by source FIELD, never by bare string: the same word means
// different things in different fields (Compute `ready` is an in-progress
// release phase and also verified process readiness).

const TONES = Object.freeze(['positive', 'progress', 'attention', 'critical', 'neutral', 'unknown']);

const GLYPHS = Object.freeze({
  positive: '●',
  progress: '◐',
  attention: '▲',
  critical: '✕',
  neutral: '○',
  unknown: '?',
});

const OUTCOMES = Object.freeze(['submitted', 'accepted', 'completed', 'failed', 'cancelled', 'rejected', 'outcome_unknown']);
const OUTCOME_LABELS = Object.freeze({
  submitted: 'Sending…',
  accepted: 'Started',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  rejected: 'Not accepted',
  outcome_unknown: 'Result unknown — check current state',
});
const VERIFICATION_STATES = Object.freeze(['verified', 'verification_failed', 'not_verified', 'not_evaluated']);
const FRESHNESS_STATES = Object.freeze(['live', 'cached', 'stale', 'unknown']);
const CAPABILITY_STATES = Object.freeze(['available', 'partial', 'unsupported']);

/// "network_ready" → "Network ready". Matches the labels products show today.
function humanize(value) {
  const text = String(value).replace(/_/g, ' ');
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

const P = 'positive';
const G = 'progress';
const A = 'attention';
const C = 'critical';
const N = 'neutral';
const U = 'unknown';

/// Condition-axis mappings. A value is either a tone or [tone, label].
/// Sources are cited so a reviewer can check each table against its enum.
const CONDITION = {
  // compute: crates/compute-environment/src/model.rs `ActualState`
  'compute.environment.actual_state': {
    running: P, completed: P, pending: G, starting: G, stopping: G, degraded: A, failed: C, denied: C, stopped: N,
  },
  // compute: crates/compute-environment/src/status.rs `Health`
  'compute.health': { healthy: P, unhealthy: C, unknown: U },
  // compute: crates/compute-environment/src/status.rs `ReadinessState` (environment)
  'compute.environment.readiness': {
    ready: P, created: G, starting: G, degraded: A, failed: C, unavailable: C,
  },
  // compute: crates/compute-core/src/computers.rs `ReadinessState` (process)
  'compute.process.readiness': { ready: P, starting: G, unready: A },
  // compute: crates/compute-core/src/computers.rs `ObservedProcess::status`, which may
  // also carry the machine's observed word when the machine is not running.
  'compute.process.state': {
    ready: P, running: P, pending: G, starting: G, stopping: G, unready: A, failed: C, lost: C,
    stopped: N, exited: N, destroyed: N, expired: N, unverified: U, unreachable: U,
  },
  // compute: crates/compute-state/src/model.rs `DeploymentStatus`
  'compute.deployment.status': {
    active: P, complete: P, pending: G, starting: G, ready: G, network_ready: G, switching: G, draining: G,
    failed: C, rolled_back: C,
  },
  // compute: crates/compute-state/src/model.rs `VersionStatus`
  'compute.version.status': { published: P, publishing: G, failed: C },
  // compute: crates/compute-state/src/model.rs `RolloutStatus`
  'compute.rollout.status': { active: P, applying: G, failed: C, superseded: N },
  // compute: crates/compute-core/src/jobs.rs `JobStatus`. `timed_out` is a definite
  // terminal failure (the job ran past its deadline and was stopped), not an
  // unknown outcome.
  'compute.job.status': {
    succeeded: P, created: G, accepted: G, queued: G, waiting_for_capacity: G, reserved: G, admitted: G,
    preparing: G, running: G, failed: C, rejected: C, timed_out: C, cancelled: N,
  },
  // compute: packages/compute-appport/src/computers.ts `ComputerReality.observed`
  'compute.computer.observed': {
    running: P, starting: G, reconciling: G, stopping: G, failed: C, lost: C,
    stopped: N, destroyed: N, expired: N, unverified: U, unreachable: U,
  },
  // compute: crates/compute-core/src/computers.rs `ComputerStatus` (stored)
  'compute.computer.status': {
    running: P, pending: G, provisioning: G, resuming: G, stopping: G, destroying: G,
    failed: C, lost: C, stopped: N, destroyed: N, expired: N, unreachable: U,
  },
  // flow_db: crates/feltdb-server/src/main.rs `/health/ready` `state`
  'feltdb.health.ready_state': { healthy: P, recovering: G, degraded: A, unavailable: C },
  // flow_db: packages/core/src/managed-recovery.ts `AuthorityAvailabilityState`
  'feltdb.authority.availability': { available: P, recovering: G, degraded: A, closed: N, unknown: U },
  // flow_db: /v1/control-plane/overview `authority.lease_clock_healthy` (boolean)
  'feltdb.authority.lease_clock_healthy': { true: [P, 'Healthy'], false: [A, 'Degraded'] },
  // authboundry: crates/authz/src/policy.rs decision `allow|deny`. A live check's
  // deny is critical; the same word on a historical record is neutral
  // (contract §6.3), so the two are separate fields.
  'authboundry.decision.live': { allow: [P, 'Allow'], deny: [C, 'Deny'] },
  'authboundry.decision.recorded': { allow: [P, 'Allow'], deny: [N, 'Deny'] },
  // authboundry: crates/server/src/control_routes.rs delegation status
  'authboundry.delegation.status': { active: P, pending: G, revoked: C, expired: N },
  // authboundry: apps/web/lib/applications.ts `ApplicationStatus`
  'authboundry.application.status': { active: P, awaiting_contract: G, disabled: N },
  // authboundry: crates/cli/src/studio.rs. Whether Studio's application is attached:
  // `GET /_authboundry/application/attachment` answers `attached` (true when an
  // upstream is configured). Not attached needs a person (Studio offers "Attach
  // Application"), so it is attention, not a fault.
  'authboundry.studio.attached': { true: [P, 'Attached'], false: [A, 'Not attached'] },
  // authboundry: crates/cli/src/studio.rs runtime protection of the attached
  // application, from the attachment and `upstream_reachable`: `active` when the
  // attached upstream answers, `inactive` when nothing is attached (by intent),
  // `unreachable` when attached but the upstream did not answer the probe (Studio
  // shows "Inactive" with "upstream unreachable"). Any other word is unknown.
  'authboundry.studio.protection': {
    active: [P, 'Active'], inactive: [N, 'Inactive'], unreachable: [A, 'Upstream unreachable'],
  },
  // appport-services: src/jobs/models.ts `JobStatus`
  'appport.job.status': { completed: P, scheduled: G, pending: G, running: G, retrying: G, failed: C },
  // appport-services: src/notifications/models.ts `NotificationStatus`
  'appport.notification.status': { delivered: P, pending: G, failed: C, read: N, acknowledged: N, expired: N },
  // appport-services: an API key is revoked when its record has `revokedAt`
  // (src/api-keys). Revocation is a deliberate end state, not a fault.
  'appport.api_key.revoked': { false: [P, 'Active'], true: [N, 'Revoked'] },
  // appport-services: a webhook endpoint is disabled when it has `disabledAt`.
  'appport.webhook.disabled': { false: [P, 'Enabled'], true: [N, 'Disabled'] },
  // appport-services: src/jobs `Schedule.enabled`.
  'appport.schedule.enabled': { true: [P, 'Enabled'], false: [N, 'Disabled'] },
  // appport-services: src/configuration/models.ts `ConfigurationSecretView.configured`,
  // which is always `true` (a listed secret is a bound one). No other value is
  // mapped, so anything else would show as unknown rather than as a guess.
  'appport.configuration.secret.configured': { true: [P, 'Configured'] },
  // appboundry: packages/core/src/application-lifecycle.ts `ApplicationLifecyclePhase`
  'appboundry.lifecycle.phase': {
    ACTIVE: [P, 'Active'], DRAFT: [G, 'Draft'], VALIDATED: [G, 'Validated'], REGISTERED: [G, 'Registered'],
    CHANGE_PROPOSED: [A, 'Change proposed'], RETIRED: [N, 'Retired'],
  },
  // appboundry: apps/cloud-portal/src/read-model.ts capability provider
  // `compatibility[].compatible`, from evaluateCompatibility against a consumer.
  'appboundry.provider.compatible': { true: [P, 'Compatible'], false: [A, 'Incompatible'] },
  // appboundry: packages/core/src/execution-ledger.ts `ExecutionStatus`, the
  // ledger record the cloud portal lists. All five are written by
  // AuthorizedExecutionService (`running` on begin, the others on complete).
  'appboundry.execution.status': {
    succeeded: P, running: G, failed: C, timed_out: [C, 'Timed out'], cancelled: N,
  },
  // appboundry: packages/core/src/application-source.ts `ApplicationSourceStatus`.
  // `pending` is declared but no code path writes it, so it is not mapped.
  'appboundry.source.status': { connected: P, stale: A, failed: C, disconnected: N },
  // appboundry: packages/core/src/application-implementation.ts
  // `ApplicationImplementationStatus`, as a condition: whether the
  // implementation may still be selected. Whether it was verified is the
  // separate verification field below. `failed` is declared but never written.
  'appboundry.implementation.status': { verified: [P, 'Current'], stale: A, revoked: C },
  // appboundry: apps/cloud-portal/src/authority.ts provider `eligibility`
  // (ELIGIBLE | INELIGIBLE). Not being eligible in a context is not a fault.
  'appboundry.provider.eligibility': { ELIGIBLE: [P, 'Eligible'], INELIGIBLE: [N, 'Ineligible'] },
  // appboundry: packages/cli/src/commands.ts, the host's deployment status. Host
  // catalog entries (`PortableHostCatalogEntry.status`, what /appboundry/api/applications
  // and host discovery report) are `running` | `stopped`; deployment records
  // (`AppBoundryDeploymentRecord.status`) are `running` (managed: the host executes
  // it) | `available` (deployed for self-provided compute; the host does not run it).
  // AppBoundry writes no failed value here: a failed deployment is the operation's
  // outcome and the failed step below. `running` is the recorded status, not an
  // observation (host discovery's `lifecycle.observed` is that).
  'appboundry.deployment.status': { running: P, available: N, stopped: N },
  // appboundry: packages/cli/src/commands.ts `SourceDeploymentStep.status`, in the
  // `AppBoundry/source-deployment/1` response. The response arrives when the
  // deployment has finished, so a step still `pending` was never run (an earlier
  // step failed); it is not in progress.
  'appboundry.deployment.step': { complete: P, failed: C, pending: [N, 'Not run'] },
  // appboundry: apps/cloud-portal/src/read-model.ts `health.ready`
  'appboundry.health.ready': { true: [P, 'Ready'], false: [C, 'Not ready'] },
  // appboundry: apps/cloud-portal/src/read-model.ts `PortalHealthCheck.status`
  'appboundry.health.check': { available: P, degraded: A, unavailable: C },
};

/// Verification-axis mappings: field value → verification state.
const VERIFICATION = {
  // flow_db: crates/feltdb-server/src/control_plane.rs `revision_to_json` re-checks
  // a revision's content against its id.
  'feltdb.revision.integrity_verified': { true: 'verified', false: 'verification_failed' },
  // appboundry: packages/core/src/application-implementation.ts. `verified` is
  // written only after the source is verified, covers the capability and
  // attests the authoritative contract; `stale` means the contract has since
  // changed, so that verification no longer holds. `revoked` says nothing
  // about verification and is shown by the condition field instead.
  // Same source field as the condition above, on the verification axis.
  'appboundry.implementation.verification': { verified: 'verified', stale: 'not_verified' },
  // appboundry: packages/core/src/contract-attestation.ts `ContractAttestationStatus`.
  // The failed check is named by the value (repository identity or contract).
  'appboundry.attestation.status': {
    verified: 'verified', CONTRACT_MISMATCH: 'verification_failed', IDENTITY_MISMATCH: 'verification_failed',
  },
  // appboundry: packages/core/src/application-conformance.ts `ConformanceReport.status`;
  // the checks are the report's own checks, PASS → passed and FAIL → failed.
  'appboundry.conformance.status': { CONFORMING: 'verified', NON_CONFORMING: 'verification_failed' },
};

/// Freshness-axis mappings.
const FRESHNESS = {
  // compute: crates/compute-environment/src/api.rs `X-Compute-State`
  'compute.response.state': { live: 'live', cached: 'cached', stale: 'stale' },
  // flow_db: packages/core/src/runtime-snapshot.ts staleness
  'feltdb.snapshot.staleness': { current: 'live', stale: 'stale', unknown: 'unknown' },
};

const freezeAll = (table) => Object.freeze(Object.fromEntries(
  Object.entries(table).map(([field, values]) => [field, Object.freeze({ ...values })]),
));
const CONDITION_FIELDS = freezeAll(CONDITION);
const VERIFICATION_FIELDS = freezeAll(VERIFICATION);
const FRESHNESS_FIELDS = freezeAll(FRESHNESS);

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/// Every field this release maps, by axis.
function fields() {
  return {
    condition: Object.keys(CONDITION_FIELDS),
    verification: Object.keys(VERIFICATION_FIELDS),
    freshness: Object.keys(FRESHNESS_FIELDS),
  };
}

/// The source values a field maps, in declaration order.
function valuesOf(field) {
  const table = CONDITION_FIELDS[field] || VERIFICATION_FIELDS[field] || FRESHNESS_FIELDS[field];
  if (!table) throw new Error(`unknown field: ${field}`);
  return Object.keys(table);
}

/// The condition of one source value. Unmapped values are `unknown` with the
/// raw value as their label, so nothing renders as healthy by omission.
function resolve(field, value, options) {
  const table = CONDITION_FIELDS[field];
  if (!table) throw new Error(`unknown field: ${field}`);
  const key = String(value);
  const entry = has(table, key) ? table[key] : null;
  const [tone, label] = entry === null ? [U, null] : (Array.isArray(entry) ? entry : [entry, null]);
  const text = (options && options.label) || label || (entry === null ? key : humanize(key));
  return { field, value: key, tone, label: text, glyph: GLYPHS[tone], mapped: entry !== null };
}

/// A verification state with its checks. `verified` requires at least one
/// listed check; without one the claim is `not_evaluated` (contract §6.1 rule 1).
function verification(state, checks) {
  const list = normalizeChecks(checks);
  let normalized = VERIFICATION_STATES.includes(state) ? state : 'not_evaluated';
  if (normalized === 'verified' && list.length === 0) normalized = 'not_evaluated';
  if (normalized === 'verified' && list.some((check) => check.status === 'failed')) normalized = 'verification_failed';
  return { state: normalized, checks: list };
}

/// A verification state from a mapped source field.
function verificationOf(field, value, checks) {
  const table = VERIFICATION_FIELDS[field];
  if (!table) throw new Error(`unknown field: ${field}`);
  const key = String(value);
  const state = has(table, key) ? table[key] : 'not_evaluated';
  const list = normalizeChecks(checks).map((check) => ({
    ...check,
    status: check.status || (state === 'verified' ? 'passed' : state === 'verification_failed' ? 'failed' : undefined),
  }));
  return verification(state, list);
}

/// A freshness state from a mapped source field; anything else is `unknown`.
function freshnessOf(field, value) {
  const table = FRESHNESS_FIELDS[field];
  if (!table) throw new Error(`unknown field: ${field}`);
  const key = String(value);
  return has(table, key) ? table[key] : 'unknown';
}

/// A capability status; anything undeclared is `unsupported` (FeltDB's rule).
function capability(status) {
  return CAPABILITY_STATES.includes(status) ? status : 'unsupported';
}

function normalizeChecks(checks) {
  if (!checks) return [];
  return checks.map((check) => (typeof check === 'string'
    ? { label: check }
    : { label: String(check.label), ...(check.status ? { status: check.status } : {}) }));
}

// ---- brand.js
// The Boundry portfolio as data (docs/brand.md). Shared marketing components
// read it so every site names the company, links to boundry.company and lists
// its sibling products the same way. Content mirrors rkendel1/boundry
// content/products.json; product accents live in @stack-ui/tokens brand.json.
// A product `href` is its own public site only where that domain was checked
// to serve one (docs/brand.md §7); otherwise it is the product's entry on
// boundry.company.

const PORTFOLIO = Object.freeze({
  company: Object.freeze({
    name: 'Boundry',
    href: 'https://boundry.company',
    tagline: 'Infrastructure for applications and agents.',
    family: 'Part of the Boundry family of products',
  }),
  products: Object.freeze([
    { id: 'feltdb', name: 'FeltDB', mark: 'FD', category: 'Durable state', href: 'https://feltdb.com' },
    { id: 'feltkit', name: 'FeltKit', mark: 'FK', category: 'Developer platform', href: 'https://getfeltkit.com' },
    { id: 'appboundry', name: 'AppBoundry', mark: 'AB', category: 'Application boundaries', href: 'https://appboundry.com' },
    { id: 'authboundry', name: 'AuthBoundry', mark: 'AU', category: 'Authority and delegation', href: 'https://authboundry.com' },
    { id: 'appport', name: 'AppPort', mark: 'AP', category: 'Application capabilities', href: 'https://boundry.company/ecosystem/#appport' },
  ].map((product) => Object.freeze(product))),
});

/// The portfolio entry for a product id, or null.
function portfolioProduct(id) {
  return PORTFOLIO.products.find((product) => product.id === id) || null;
}

// ---- view.js
// Component structure (docs/design-system-contract.md §4–5) as plain trees:
//   { t: tag, a: attributes, c: children, on: { event: handler } }
// Children are trees, strings, numbers, null/false (skipped), arrays, or opaque
// slot content (a DOM Node or a React element) passed through untouched.
// dom.js and the React binding both render these trees, so the DOM a component
// produces is the same in every product.


// `k` is an optional identity among siblings (React's key); dom.js ignores it.
const node = (t, a, c, on, k) => ({ t, a: a || {}, c: c === undefined ? [] : [].concat(c), ...(on ? { on } : {}), ...(k === undefined || k === null ? {} : { k: String(k) }) });
const isTree = (value) => Boolean(value && typeof value === 'object' && typeof value.t === 'string' && value.a && Array.isArray(value.c));

const cx = (...names) => names.filter(Boolean).join(' ');
const present = (value) => value !== null && value !== undefined && value !== '';

/// Extra attributes a product passes through (data-*, aria-*, id, title).
const passthrough = (attrs) => {
  const out = {};
  for (const [key, value] of Object.entries(attrs || {})) {
    if (/^(data-|aria-)/.test(key) || key === 'id' || key === 'title') out[key] = value;
  }
  return out;
};

/// Deterministic timestamp text, identical in every renderer and timezone.
function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}
/// A <time> element, or the raw text when the value is not a valid time: a
/// malformed timestamp from a product must never break the page around it.
const timeNode = (value, cls) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? node('span', { class: cls }, String(value))
    : node('time', { class: cls, datetime: date.toISOString() }, formatTime(value));
};

function StatusIndicator(props) {
  const { field, value, detail, className, attrs } = props;
  const resolved = field ? resolve(field, value, { label: props.label }) : null;
  const tone = resolved ? resolved.tone : (props.tone || 'unknown');
  const label = resolved ? resolved.label : (present(props.label) ? props.label : humanize(tone));
  const glyph = props.glyph || GLYPHS[tone] || GLYPHS.unknown;
  return node('span', {
    class: cx('stack-status', `stack-status--${tone}`, className),
    'data-tone': tone,
    ...(resolved ? { 'data-field': resolved.field, 'data-value': resolved.value } : {}),
    ...passthrough(attrs),
  }, [
    node('span', { class: 'stack-status__glyph', 'aria-hidden': 'true' }, glyph),
    node('span', { class: 'stack-status__label' }, label),
    present(detail) ? node('span', { class: 'stack-status__detail' }, detail) : null,
  ]);
}

const VERIFICATION_GLYPHS = { verified: '✓', verification_failed: '✕', not_verified: '!', not_evaluated: '–' };

function VerificationBadge(props) {
  const { state, checks } = verification(props.state, props.checks);
  const failed = checks.filter((check) => check.status === 'failed');
  let label;
  if (state === 'verified') label = checks.length === 1 ? `Verified · ${checks[0].label}` : `Verified · ${checks.length} checks`;
  else if (state === 'verification_failed') {
    const named = failed.length ? failed : checks;
    label = named.length === 1 ? `Verification failed · ${named[0].label}`
      : named.length ? `Verification failed · ${named.length} checks` : 'Verification failed';
  } else label = state === 'not_verified' ? 'Not verified' : 'Not evaluated';
  return node('div', {
    class: cx('stack-verification', `stack-verification--${state}`, props.className),
    'data-verification': state,
    ...passthrough(props.attrs),
  }, [
    node('span', { class: 'stack-verification__glyph', 'aria-hidden': 'true' }, VERIFICATION_GLYPHS[state]),
    node('span', { class: 'stack-verification__label' }, label),
    present(props.at) ? [' · ', timeNode(props.at, 'stack-verification__at')] : null,
    present(props.evidenceHref) ? node('a', { class: 'stack-verification__evidence', href: props.evidenceHref }, 'Evidence') : null,
    checks.length > 1 ? node('ul', { class: 'stack-verification__checks' }, checks.map((check) => node('li', {
      class: 'stack-verification__check',
      ...(check.status ? { 'data-check-status': check.status } : {}),
    }, check.status ? `${check.label} — ${check.status}` : check.label))) : null,
  ]);
}

const FRESHNESS_LABELS = { live: 'Live', cached: 'Cached', stale: 'Stale', unknown: 'Freshness unknown' };
const FRESHNESS_GLYPHS = { live: '●', cached: '◷', stale: '▲', unknown: '?' };

function FreshnessLabel(props) {
  const freshness = FRESHNESS_LABELS[props.freshness] ? props.freshness : 'unknown';
  const showAsOf = present(props.asOf) && freshness !== 'live';
  return node('span', {
    class: cx('stack-freshness', `stack-freshness--${freshness}`, props.className),
    'data-freshness': freshness,
    ...passthrough(props.attrs),
  }, [
    node('span', { class: 'stack-freshness__glyph', 'aria-hidden': 'true' }, FRESHNESS_GLYPHS[freshness]),
    node('span', { class: 'stack-freshness__label' }, [
      FRESHNESS_LABELS[freshness],
      showAsOf ? [' · as of ', timeNode(props.asOf, 'stack-freshness__as-of')] : null,
      present(props.source) ? ` · ${props.source}` : null,
    ]),
  ]);
}

function Unavailable(props) {
  const status = props.status === 'partial' ? 'partial' : 'unsupported';
  const title = present(props.title) ? props.title : (status === 'partial' ? 'Partly available' : 'Not available');
  return node('div', {
    class: cx('stack-unavailable', `stack-unavailable--${status}`, props.className),
    role: 'note',
    'data-capability-status': status,
    ...(present(props.capability) ? { 'data-capability': props.capability } : {}),
    ...passthrough(props.attrs),
  }, [
    node(props.headingLevel ? heading(props.headingLevel) : 'p', { class: 'stack-unavailable__title' }, title),
    present(props.reason) ? node('p', { class: 'stack-unavailable__reason' }, props.reason) : null,
    props.children || null,
  ]);
}

function Loading(props) {
  const what = present(props.what) ? props.what : '';
  const text = props.long ? `Still loading${what ? ` ${what}` : ''}…` : `Loading${what ? ` ${what}` : ''}…`;
  return node('div', {
    class: cx('stack-loading', props.long ? 'stack-loading--long' : null, props.className),
    role: 'status',
    'aria-live': 'polite',
    ...passthrough(props.attrs),
  }, [
    node('span', { class: 'stack-loading__indicator', 'aria-hidden': 'true' }),
    node('span', { class: 'stack-loading__label' }, text),
  ]);
}

const heading = (level) => `h${Math.min(6, Math.max(1, Number(level) || 2))}`;

function EmptyState(props) {
  const variant = props.variant === 'no-match' ? 'no-match' : 'empty';
  const title = present(props.title) ? props.title : (variant === 'no-match' ? 'Nothing matches' : 'Nothing here yet');
  return node('div', {
    class: cx('stack-empty', `stack-empty--${variant}`, props.className),
    ...passthrough(props.attrs),
  }, [
    node(heading(props.headingLevel), { class: 'stack-empty__title' }, title),
    present(props.body) ? node('p', { class: 'stack-empty__body' }, props.body) : null,
    props.action ? node('div', { class: 'stack-empty__action' }, props.action) : null,
  ]);
}

function ErrorPanel(props) {
  const meta = [
    present(props.code) ? ['Code ', node('code', {}, props.code)] : null,
    present(props.requestId) ? [present(props.code) ? ' · ' : '', 'Request ', node('code', {}, props.requestId)] : null,
  ].filter(Boolean);
  return node('div', {
    class: cx('stack-error', props.className),
    role: 'alert',
    ...passthrough(props.attrs),
  }, [
    node('p', { class: 'stack-error__title' }, present(props.title) ? props.title : 'Something went wrong'),
    present(props.message) ? node('p', { class: 'stack-error__message' }, props.message) : null,
    meta.length ? node('p', { class: 'stack-error__meta' }, meta) : null,
    props.onRetry || props.actions ? node('div', { class: 'stack-error__actions' }, [
      props.onRetry ? Button({ label: props.retryLabel || 'Retry', onClick: props.onRetry }) : null,
      props.actions || null,
    ]) : null,
  ]);
}

function MetadataList(props) {
  return node('dl', { class: cx('stack-meta', props.className), ...passthrough(props.attrs) },
    (props.items || []).map((item) => {
      const missing = !present(item.value) && item.value !== 0 && item.value !== false;
      return node('div', { class: 'stack-meta__item', ...passthrough(item.attrs) }, [
        node('dt', { class: 'stack-meta__label' }, item.label),
        node('dd', {
          class: cx('stack-meta__value', item.mono ? 'stack-meta__value--mono' : null),
          ...(missing ? { 'data-missing': 'true' } : {}),
        }, missing ? '—' : (typeof item.value === 'boolean' ? String(item.value) : item.value)),
        present(item.hint) ? node('dd', { class: 'stack-meta__hint' }, item.hint) : null,
      ]);
    }));
}

function ResourceIdentity(props) {
  const length = Number(props.length) || 12;
  const id = present(props.id) ? String(props.id) : null;
  const truncated = id && id.length > length ? `${id.slice(0, length)}…` : id;
  const name = present(props.name)
    ? node(props.href ? 'a' : 'span', { class: 'stack-identity__name', ...(props.href ? { href: props.href } : {}) }, props.name)
    : null;
  return node('span', { class: cx('stack-identity', props.className), ...passthrough(props.attrs) }, [
    present(props.kind) ? node('span', { class: 'stack-identity__kind' }, props.kind) : null,
    name,
    id ? node('code', { class: 'stack-identity__id', title: id }, truncated === id ? id : [
      node('span', { 'aria-hidden': 'true' }, truncated),
      node('span', { class: 'stack-visually-hidden' }, id),
    ]) : null,
  ]);
}

function PageHeader(props) {
  return node('header', { class: cx('stack-page-header', props.className), ...passthrough(props.attrs) }, [
    present(props.eyebrow) ? node('p', { class: 'stack-page-header__eyebrow' }, props.eyebrow) : null,
    node('div', { class: 'stack-page-header__title-row' }, [
      node(heading(props.headingLevel || 1), { class: 'stack-page-header__title' }, props.title),
      props.status ? node('span', { class: 'stack-page-header__status' }, props.status) : null,
      props.actions ? node('div', { class: 'stack-page-header__actions' }, props.actions) : null,
    ]),
    present(props.description) ? node('p', { class: 'stack-page-header__description' }, props.description) : null,
    props.meta ? node('div', { class: 'stack-page-header__meta' }, props.meta) : null,
  ]);
}

const VARIANTS = ['primary', 'secondary', 'danger', 'ghost'];
const SIZES = ['sm', 'md', 'lg'];

function Button(props) {
  const variant = VARIANTS.includes(props.variant) ? props.variant : 'secondary';
  const size = SIZES.includes(props.size) ? props.size : 'md';
  const inert = Boolean(props.disabled || props.busy);
  return node('button', {
    class: cx('stack-button', `stack-button--${variant}`, `stack-button--${size}`, props.className),
    type: props.type === 'submit' ? 'submit' : 'button',
    ...(inert ? { disabled: true } : {}),
    ...(props.busy ? { 'aria-busy': 'true' } : {}),
    ...passthrough(props.attrs),
  }, [
    props.busy ? node('span', { class: 'stack-button__busy', 'aria-hidden': 'true' }) : null,
    node('span', { class: 'stack-button__label' }, props.label),
  ], props.onClick && !inert ? { click: props.onClick } : undefined);
}

// ---- Navigation and lists (PR3) ---------------------------------------------

/// A resource path. The last item is the current page.
function Breadcrumbs(props) {
  const items = (props.items || []).filter((item) => item && present(item.label));
  return node('nav', {
    class: cx('stack-breadcrumbs', props.className),
    'aria-label': props.label || 'Breadcrumb',
    ...passthrough(props.attrs),
  }, node('ol', { class: 'stack-breadcrumbs__list' }, items.map((item, index) => {
    const last = index === items.length - 1;
    return node('li', { class: 'stack-breadcrumbs__item' }, [
      index > 0 ? node('span', { class: 'stack-breadcrumbs__separator', 'aria-hidden': 'true' }, '/') : null,
      last || !present(item.href)
        ? node('span', { class: 'stack-breadcrumbs__current', ...(last ? { 'aria-current': 'page' } : {}) }, item.label)
        : node('a', { class: 'stack-breadcrumbs__link', href: item.href }, item.label),
    ]);
  })));
}

/// Moves focus between tabs with the arrow keys, Home and End (manual
/// activation: Enter or Space selects, as on any button). Works with a native
/// event and with React's synthetic event alike.
function tabsKeydown(event) {
  const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const list = event.currentTarget;
  const tabs = Array.from(list.querySelectorAll('[role="tab"]:not([disabled])'));
  if (!tabs.length) return;
  const current = tabs.indexOf(list.ownerDocument.activeElement);
  const vertical = list.getAttribute('aria-orientation') === 'vertical';
  const forward = vertical ? 'ArrowDown' : 'ArrowRight';
  const backward = vertical ? 'ArrowUp' : 'ArrowLeft';
  let next;
  if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = tabs.length - 1;
  else if (event.key === forward) next = current < 0 ? 0 : (current + 1) % tabs.length;
  else if (event.key === backward) next = current < 0 ? tabs.length - 1 : (current - 1 + tabs.length) % tabs.length;
  else return;
  event.preventDefault();
  // Focus moves; tabindex stays on the selected tab, so Tab into the list
  // returns to it, and a renderer that owns the attributes (React) never sees
  // them change underneath it.
  tabs[next].focus();
}

const idPart = (value) => String(value).replace(/[^A-Za-z0-9_-]/g, '-');

const skipToMain = (mainId) => (event) => {
  const main = event.currentTarget.ownerDocument.getElementById(mainId);
  if (!main) return;
  event.preventDefault();
  main.focus();
  if (typeof main.scrollIntoView === 'function') main.scrollIntoView();
};

/// Sections of one resource. Selecting a tab calls `onSelect(id)`; the product
/// decides what that means (show a panel, or change its route).
function Tabs(props) {
  const prefix = idPart(props.idPrefix || 'stack-tabs');
  const tabs = props.tabs || [];
  const active = tabs.some((tab) => tab.id === props.active && !tab.disabled) ? props.active : null;
  return node('div', {
    class: cx('stack-tabs', props.className),
    role: 'tablist',
    ...(present(props.label) ? { 'aria-label': props.label } : {}),
    ...passthrough(props.attrs),
  }, tabs.map((tab, index) => {
    const selected = tab.id === active;
    const focusable = selected || (active === null && index === 0);
    return node('button', {
      class: cx('stack-tabs__tab', selected ? 'stack-tabs__tab--selected' : null, tab.className),
      type: 'button',
      role: 'tab',
      id: `${prefix}-tab-${idPart(tab.id)}`,
      'aria-selected': selected ? 'true' : 'false',
      ...(present(props.panelId) ? { 'aria-controls': props.panelId } : {}),
      tabindex: focusable ? '0' : '-1',
      ...(tab.disabled ? { disabled: true, ...(present(tab.reason) ? { title: tab.reason } : {}) } : {}),
      ...passthrough(tab.attrs),
    }, [
      tab.label,
      present(tab.badge) ? node('span', { class: 'stack-tabs__badge' }, tab.badge) : null,
    ], props.onSelect && !tab.disabled ? { click: () => props.onSelect(tab.id) } : undefined);
  }), { keydown: tabsKeydown });
}

/// The region a tablist controls.
function TabPanel(props) {
  const prefix = idPart(props.idPrefix || 'stack-tabs');
  return node('div', {
    class: cx('stack-tabpanel', props.className),
    role: 'tabpanel',
    id: props.id,
    ...(present(props.active) ? { 'aria-labelledby': `${prefix}-tab-${idPart(props.active)}` } : {}),
    tabindex: '0',
    ...passthrough(props.attrs),
  }, props.children || null);
}

const SORT_GLYPHS = { ascending: '▲', descending: '▼' };

/// Enter or Space on a selectable row selects it, as a click does.
const rowKeydown = (onSelect) => (event) => {
  if (event.target !== event.currentTarget) return;
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  onSelect();
};

/// A list of resources as a table. Rows are keyed by column id, so every row
/// has exactly one cell per header. Loading, failure, empty and no-match are
/// part of the table, not left to each screen.
function DataTable(props) {
  const columns = props.columns || [];
  const rows = props.rows || [];
  const label = present(props.label) ? props.label : 'Table';
  if (props.error) {
    return ErrorPanel({
      title: props.error.title || `${label} could not be read`,
      message: props.error.message,
      code: props.error.code,
      requestId: props.error.requestId,
      onRetry: props.error.onRetry,
      className: cx('stack-table-state', props.className),
      attrs: props.attrs,
    });
  }
  if (props.loading && !rows.length) return Loading({ what: props.loadingWhat || label.toLowerCase(), className: cx('stack-table-state', props.className), attrs: props.attrs });
  if (!rows.length) {
    const noMatch = Boolean(props.noMatch);
    return EmptyState({
      variant: noMatch ? 'no-match' : 'empty',
      title: noMatch ? (props.noMatchTitle || 'Nothing matches') : (props.emptyTitle || 'Nothing here yet'),
      body: noMatch ? props.noMatchBody : props.emptyBody,
      action: noMatch ? null : props.emptyAction,
      headingLevel: props.emptyHeadingLevel || 3,
      className: cx('stack-table-state', props.className),
      attrs: props.attrs,
    });
  }
  const sort = props.sort || {};
  const head = node('thead', {}, node('tr', {}, columns.map((column) => {
    const sorted = sort.column === column.id && SORT_GLYPHS[sort.direction] ? sort.direction : null;
    const content = column.sortable && props.onSort
      ? node('button', {
        class: 'stack-table__sort',
        type: 'button',
      }, [
        column.header,
        node('span', { class: 'stack-table__sort-indicator', 'aria-hidden': 'true' }, sorted ? SORT_GLYPHS[sorted] : '↕'),
      ], { click: () => props.onSort(column.id) })
      : column.header;
    return node('th', {
      class: cx('stack-table__header', column.align === 'end' ? 'stack-table__cell--end' : null),
      scope: 'col',
      ...(column.sortable && props.onSort ? { 'aria-sort': sorted || 'none' } : {}),
    }, content);
  })));
  const body = node('tbody', {}, rows.map((row) => {
    const selectable = typeof row.onSelect === 'function';
    return node('tr', {
      class: cx('stack-table__row', selectable ? 'stack-table__row--selectable' : null, row.selected ? 'stack-table__row--selected' : null, row.className),
      ...(selectable ? { tabindex: '0' } : {}),
      // aria-selected needs a grid; in a table the open row is the current one.
      ...(row.selected ? { 'aria-current': 'true' } : {}),
      ...passthrough(row.attrs),
    }, columns.map((column) => {
      const value = row.cells ? row.cells[column.id] : undefined;
      const missing = value === undefined || value === null;
      return node('td', {
        class: cx('stack-table__cell', column.align === 'end' ? 'stack-table__cell--end' : null),
        ...(missing ? { 'data-missing': 'true' } : {}),
      }, missing ? '—' : value);
    }), selectable ? { click: row.onSelect, keydown: rowKeydown(row.onSelect) } : undefined, row.key);
  }));
  return node('div', {
    class: cx('stack-table', props.className),
    role: 'region',
    'aria-label': label,
    tabindex: '0',
    ...(props.loading ? { 'aria-busy': 'true' } : {}),
    ...passthrough(props.attrs),
  }, node('table', { class: 'stack-table__table' }, [
    node('caption', { class: props.captionVisible ? 'stack-table__caption' : 'stack-visually-hidden' }, label),
    head,
    body,
  ]));
}

/// One labelled filter control: a text input or a select.
function filterControl(filter, prefix, onChange) {
  const id = `${prefix}-${idPart(filter.id)}`;
  const value = present(filter.value) ? String(filter.value) : '';
  const handler = onChange ? (event) => onChange(filter.id, event.target.value) : null;
  const control = filter.type === 'select'
    ? node('select', { class: 'stack-filter__control', id, name: filter.id },
      (filter.options || []).map((option) => {
        const optionValue = String(typeof option === 'object' ? option.value : option);
        return node('option', { value: optionValue, ...(optionValue === value ? { selected: true } : {}) },
          typeof option === 'object' ? option.label : option);
      }), handler ? { change: handler } : undefined)
    : node('input', {
      class: 'stack-filter__control', id, name: filter.id, type: 'search', value,
      ...(present(filter.placeholder) ? { placeholder: filter.placeholder } : {}),
    }, [], handler ? { input: handler } : undefined);
  return node('div', { class: 'stack-filter__field' }, [
    node('label', { class: 'stack-filter__label', for: id }, filter.label),
    control,
  ]);
}

/// Labelled filters for a list. Applying calls `onSubmit()`; the product reads
/// its own filter state and fetches. The result line is announced politely.
function FilterBar(props) {
  const prefix = idPart(props.idPrefix || 'stack-filter');
  const applied = Number(props.applied) || 0;
  return node('form', {
    class: cx('stack-filter', props.className),
    role: 'search',
    'aria-label': props.label || 'Filters',
    ...passthrough(props.attrs),
  }, [
    node('div', { class: 'stack-filter__controls' }, [
      (props.filters || []).map((filter) => filterControl(filter, prefix, props.onChange)),
      node('div', { class: 'stack-filter__actions' }, [
        // Live filters apply as they change, so there is nothing to submit.
        props.live ? null : Button({ label: props.applyLabel || 'Apply', type: 'submit', variant: 'secondary' }),
        applied && props.onClear ? Button({ label: props.clearLabel || 'Clear', variant: 'ghost', onClick: props.onClear }) : null,
      ]),
    ]),
    node('p', { class: 'stack-filter__result', role: 'status', 'aria-live': 'polite' }, present(props.result) ? props.result : ''),
  ], props.onSubmit || props.live ? {
    // Submitting a filter form never navigates (a single text field submits
    // on Enter even with no button).
    submit: (event) => { event.preventDefault(); if (props.onSubmit) props.onSubmit(); },
  } : undefined);
}

/// Cursor pagination: previous and next, and whatever summary the product can
/// state truthfully. It never invents a total or a page count.
function Pagination(props) {
  return node('nav', {
    class: cx('stack-pagination', props.className),
    'aria-label': props.label || 'Pagination',
    ...passthrough(props.attrs),
  }, [
    present(props.summary) ? node('p', { class: 'stack-pagination__summary' }, props.summary) : null,
    node('div', { class: 'stack-pagination__actions' }, [
      Button({ label: props.previousLabel || '← Previous', variant: 'ghost', disabled: !props.hasPrevious, onClick: props.onPrevious, attrs: { 'data-page': 'previous' } }),
      Button({ label: props.nextLabel || 'Next →', variant: 'ghost', disabled: !props.hasNext, onClick: props.onNext, attrs: { 'data-page': 'next' } }),
    ]),
  ]);
}

// ---- The product shell (docs/product-shell.md) ----------------------------

const THEME_OPTIONS = Object.freeze([
  { value: 'system', label: 'System theme' },
  { value: 'light', label: 'Light theme' },
  { value: 'dark', label: 'Dark theme' },
]);

/// The page frame every Stack product renders in its own build: product mark,
/// product context, search and account slots, theme preference, this
/// product's navigation, links out to other Stack products, and the main
/// landmark. It renders exactly what it is given: no data, no network, no
/// authorization.
function Shell(props) {
  const product = props.product || {};
  // A product with client-side routing takes ordinary clicks itself; a click
  // with a modifier (new tab, new window) stays a normal link.
  const navigate = (href) => (props.onNavigate ? {
    click: (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      props.onNavigate(href);
    },
  } : undefined);
  const mainId = idPart(props.mainId || 'stack-main');
  // Narrow screens: the navigation is a scrolling strip (the default), or,
  // when a product opts in with `narrowNavigation: 'menu'` and owns the open
  // state (`navigationOpen`, `onNavigationToggle`), a menu behind a button in
  // the bar. Without the toggle there is no way to open it, so it stays a strip.
  const menu = props.narrowNavigation === 'menu' && typeof props.onNavigationToggle === 'function';
  const open = menu && Boolean(props.navigationOpen);
  const navId = `${mainId}-nav`;
  const menuButtonId = `${mainId}-menu-button`;
  const closeMenu = (event) => {
    props.onNavigationToggle(false);
    const button = event.currentTarget.ownerDocument.getElementById(menuButtonId);
    if (button) button.focus();
  };
  const groups = [];
  for (const item of props.navigation || []) {
    const name = item.group || '';
    let group = groups.find((entry) => entry.name === name);
    if (!group) groups.push(group = { name, items: [] });
    group.items.push(item);
  }
  for (const group of groups) group.items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  // In an open menu, following a link also closes it.
  const follow = (href) => {
    const routed = navigate(href);
    if (!open) return routed;
    return {
      // Close first: the route change then moves focus to the new page.
      click: (event) => {
        if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) props.onNavigationToggle(false);
        if (routed) routed.click(event);
      },
    };
  };
  const navItem = (item) => node('li', { class: 'stack-shell__nav-entry' }, node('a', {
    class: cx('stack-shell__nav-item', item.className),
    href: item.href,
    ...(item.current ? { 'aria-current': 'page' } : {}),
    ...passthrough(item.attrs),
  }, item.label, follow(item.href)));
  const theme = props.theme;
  const themeId = `${mainId}-theme`;
  // A product in the Boundry portfolio lists its siblings by default; a
  // product passes `otherProducts` to choose (or [] to show none).
  const others = props.otherProducts
    || (present(product.id) && portfolioProduct(product.id)
      ? PORTFOLIO.products.filter((entry) => entry.id !== product.id).map((entry) => ({ name: entry.name, href: entry.href }))
      : []);
  const family = present(product.id) && portfolioProduct(product.id) && props.family !== false;
  return node('div', {
    class: cx('stack-shell', menu ? 'stack-shell--menu' : null, open ? 'stack-shell--menu-open' : null, props.className),
    ...(present(product.id) ? { 'data-stack-product': product.id } : {}),
    ...passthrough(props.attrs),
  }, [
    // Focuses the main landmark itself: in a hash-routed product, following
    // `#main` would change the route.
    node('a', { class: 'stack-shell__skip', href: `#${mainId}` }, props.skipLabel || 'Skip to content', { click: skipToMain(mainId) }),
    node('header', { class: 'stack-shell__bar' }, [
      menu ? node('button', {
        class: 'stack-shell__menu-button', type: 'button', id: menuButtonId,
        'aria-expanded': open ? 'true' : 'false', 'aria-controls': navId,
      }, [
        node('span', { 'aria-hidden': 'true' }, open ? '\u2715' : '\u2630'),
        node('span', { class: 'stack-visually-hidden' }, props.menuLabel || 'Menu'),
      ], {
        click: () => props.onNavigationToggle(!open),
        // Escape closes the open menu from its button too, not only from inside it.
        ...(open ? { keydown: (event) => { if (event.key === 'Escape') { event.preventDefault(); props.onNavigationToggle(false); } } } : {}),
      }) : null,
      node('a', { class: 'stack-shell__product', href: product.homeHref || '#' }, [
        present(product.mark) ? node('span', { class: 'stack-shell__mark', 'aria-hidden': 'true' }, product.mark) : null,
        node('span', { class: 'stack-shell__product-name' }, product.name || ''),
      ], navigate(product.homeHref || '#')),
      props.context ? node('div', { class: 'stack-shell__context' }, props.context) : null,
      props.search ? node('div', { class: 'stack-shell__search' }, props.search) : null,
      node('div', { class: 'stack-shell__end' }, [
        theme ? node('div', { class: 'stack-shell__prefs' }, [
          node('label', { class: 'stack-visually-hidden', for: themeId }, 'Theme'),
          node('select', { class: 'stack-shell__theme', id: themeId, 'data-stack-theme-control': '' },
            THEME_OPTIONS.map((option) => node('option', {
              value: option.value, ...(option.value === (theme.preference || 'system') ? { selected: true } : {}),
            }, option.label)), theme.onChange ? { change: (event) => theme.onChange(event.target.value) } : undefined),
        ]) : null,
        props.account ? node('div', { class: 'stack-shell__account' }, props.account) : null,
        family ? node('a', { class: 'stack-shell__family', href: PORTFOLIO.company.href }, [
          BrandMark({ idPrefix: `${mainId}-family-mark` }),
          node('span', {}, ['A ', PORTFOLIO.company.name, ' product']),
        ]) : null,
      ]),
    ]),
    node('div', { class: 'stack-shell__body' }, [
      node('nav', {
        class: 'stack-shell__nav', 'aria-label': `${product.name || 'Product'} navigation`,
        ...(menu ? { id: navId } : {}),
      }, [
        groups.map((group) => node('div', { class: 'stack-shell__nav-group' }, [
          present(group.name) ? node('p', { class: 'stack-shell__nav-heading' }, group.name) : null,
          node('ul', { class: 'stack-shell__nav-list' }, group.items.map(navItem)),
        ])),
        present(props.activityHref) ? node('div', { class: 'stack-shell__nav-group stack-shell__activity' },
          node('ul', { class: 'stack-shell__nav-list' }, navItem({ label: props.activityLabel || 'Activity', href: props.activityHref, current: props.activityCurrent }))) : null,
        others.length || family ? node('div', { class: 'stack-shell__nav-group stack-shell__switcher' }, [
          node('p', { class: 'stack-shell__nav-heading' }, props.otherProductsLabel || 'Other Boundry products'),
          node('ul', { class: 'stack-shell__nav-list' }, [
            others.map((other) => node('li', { class: 'stack-shell__nav-entry' },
              node('a', { class: 'stack-shell__nav-item', href: other.href }, other.name))),
            family ? node('li', { class: 'stack-shell__nav-entry' }, node('a', { class: 'stack-shell__nav-item stack-shell__nav-item--company', href: PORTFOLIO.company.href }, ['About ', PORTFOLIO.company.name])) : null,
          ]),
        ]) : null,
      ], open ? { keydown: (event) => { if (event.key === 'Escape') { event.preventDefault(); closeMenu(event); } } } : undefined),
      node('main', { class: 'stack-shell__main', id: mainId, tabindex: '-1', ...passthrough(props.mainAttrs) }, props.children || null),
    ]),
  ]);
}

// ---- Forms and dialogs (PR4) ------------------------------------------------

// HTML constraint attributes a field passes to its control unchanged. They
// mirror the product's own rules for the browser; the product still validates.
const CONSTRAINTS = ['pattern', 'min', 'max', 'step', 'minlength', 'maxlength', 'autocomplete', 'inputmode', 'list', 'spellcheck'];

const fieldId = (props) => idPart(present(props.id) ? props.id : `stack-field-${props.name || 'field'}`);

/// The label, hint and error around one control, wired by id: the label is
/// always visible (never a placeholder), and hint and error are announced with
/// the control through aria-describedby.
function field(props, id, control, kind) {
  return node('div', {
    class: cx('stack-field', `stack-field--${kind}`, props.error ? 'stack-field--invalid' : null, props.className),
    ...passthrough(props.attrs),
  }, [
    node('label', { class: 'stack-field__label', for: id }, [
      props.label,
      props.required ? node('span', { class: 'stack-field__required', 'aria-hidden': 'true' }, ' *') : null,
    ]),
    control,
    present(props.hint) ? node('p', { class: 'stack-field__hint', id: `${id}-hint` }, props.hint) : null,
    present(props.error) ? node('p', { class: 'stack-field__error', id: `${id}-error` }, props.error) : null,
  ]);
}

const describedBy = (props, id) => {
  const ids = [present(props.hint) ? `${id}-hint` : null, present(props.error) ? `${id}-error` : null].filter(Boolean);
  return ids.length ? { 'aria-describedby': ids.join(' ') } : {};
};

const controlState = (props, id) => ({
  ...(props.required ? { required: true } : {}),
  ...(props.readOnly ? { readonly: true } : {}),
  ...(props.disabled ? { disabled: true } : {}),
  ...(present(props.error) ? { 'aria-invalid': 'true' } : {}),
  ...describedBy(props, id),
});

/// A labelled text input, or a textarea with `multiline`. `onChange(value)` is
/// called on every edit; without it the control is uncontrolled and a form
/// reads it on submit.
function TextField(props) {
  const id = fieldId(props);
  // A value is rendered only when the product gives one ('' included), so a
  // field with onChange and no value stays free to type in, in every renderer.
  const given = props.value !== undefined && props.value !== null;
  const value = given ? String(props.value) : null;
  const handler = props.onChange ? { input: (event) => props.onChange(event.target.value) } : undefined;
  const constraints = {};
  for (const name of CONSTRAINTS) if (present(props[name])) constraints[name] = String(props[name]);
  const shared = {
    class: 'stack-field__control',
    id,
    ...(present(props.name) ? { name: props.name } : {}),
    ...(present(props.placeholder) ? { placeholder: props.placeholder } : {}),
    ...constraints,
    ...controlState(props, id),
  };
  const control = props.multiline
    ? node('textarea', { ...shared, rows: String(Number(props.rows) || 4) }, given ? value : [], handler)
    : node('input', { ...shared, type: props.type || 'text', ...(given ? { value } : {}) }, [], handler);
  return field(props, id, control, props.multiline ? 'multiline' : 'text');
}

/// A labelled select. Options are strings or `{value, label, disabled}`.
function Select(props) {
  const id = fieldId(props);
  const value = present(props.value) ? String(props.value) : null;
  const handler = props.onChange ? { change: (event) => props.onChange(event.target.value) } : undefined;
  const control = node('select', {
    class: 'stack-field__control',
    id,
    ...(present(props.name) ? { name: props.name } : {}),
    ...controlState(props, id),
  }, (props.options || []).map((option) => {
    const optionValue = String(typeof option === 'object' ? option.value : option);
    return node('option', {
      value: optionValue,
      ...(optionValue === value ? { selected: true } : {}),
      ...(typeof option === 'object' && option.disabled ? { disabled: true } : {}),
    }, typeof option === 'object' ? option.label : option);
  }), handler);
  return field(props, id, control, 'select');
}

/// A form of labelled fields with one submit button. Submitting never
/// navigates: `onSubmit(event)` is called and the product sends the request.
/// `busy` marks the submit button while that request is in flight.
function Form(props) {
  return node('form', {
    class: cx('stack-form', props.layout === 'inline' ? 'stack-form--inline' : null, props.className),
    ...(present(props.label) ? { 'aria-label': props.label } : {}),
    ...(present(props.id) ? { id: idPart(props.id) } : {}),
    ...(props.busy ? { 'aria-busy': 'true' } : {}),
    ...passthrough(props.attrs),
  }, [
    node('div', { class: 'stack-form__fields' }, props.children || null),
    node('div', { class: 'stack-form__actions' }, [
      Button({ label: props.submitLabel || 'Save', type: 'submit', variant: props.submitVariant || 'primary', busy: props.busy }),
      props.actions || null,
    ]),
  ], {
    submit: (event) => {
      event.preventDefault();
      if (props.onSubmit) props.onSubmit(event);
    },
  });
}

/// A modal dialog's structure (a native <dialog>). Opening it is the
/// renderer's job: `openDialog` in dom.js, or the React binding's `open` prop.
/// Esc never closes it by itself: it calls `onClose`, as the Cancel action
/// does, and a dialog without `onClose` (one that is busy) stays open.
function Dialog(props) {
  const id = idPart(props.id || 'stack-dialog');
  const described = [present(props.description) ? `${id}-description` : null, ...(props.describedBy || [])].filter(Boolean);
  return node('dialog', {
    class: cx('stack-dialog', props.className),
    id,
    ...(props.role === 'alertdialog' ? { role: 'alertdialog' } : {}),
    'aria-labelledby': `${id}-title`,
    ...(described.length ? { 'aria-describedby': described.join(' ') } : {}),
    ...passthrough(props.attrs),
  }, node('div', { class: 'stack-dialog__surface' }, [
    node('h2', { class: 'stack-dialog__title', id: `${id}-title` }, props.title),
    present(props.description) ? node('p', { class: 'stack-dialog__description', id: `${id}-description` }, props.description) : null,
    props.children ? node('div', { class: 'stack-dialog__body' }, props.children) : null,
    props.actions ? node('div', { class: 'stack-dialog__actions' }, props.actions) : null,
  ]), {
    cancel: (event) => { event.preventDefault(); if (props.onClose) props.onClose(); },
  });
}

/// Confirms a destructive or irreversible action (contract §7.8). It lists the
/// consequences the product states, names the action on its button (never
/// "OK"), and, with `requireText`, stays disabled until that text is typed.
/// `busy` and `error` show the request the confirmation started; the product
/// reports the outcome.
function ConfirmAction(props) {
  const id = idPart(props.id || 'stack-confirm');
  const consequences = (props.consequences || []).filter(present);
  const typedOk = !present(props.requireText) || props.typed === props.requireText;
  return Dialog({
    id,
    role: 'alertdialog',
    title: props.title,
    description: props.description,
    // The consequences are what the person must hear when the dialog opens.
    describedBy: consequences.length ? [`${id}-consequences`] : [],
    className: cx('stack-confirm', props.className),
    attrs: props.attrs,
    onClose: props.busy ? null : props.onCancel,
    children: [
      consequences.length ? node('ul', { class: 'stack-confirm__consequences', id: `${id}-consequences` }, consequences.map((text) => node('li', {}, text))) : null,
      present(props.requireText) ? TextField({
        id: `${id}-typed`,
        name: 'confirm',
        label: props.requireTextLabel || `Type ${props.requireText} to confirm`,
        value: props.typed === undefined || props.typed === null ? '' : props.typed,
        autocomplete: 'off',
        spellcheck: 'false',
        disabled: props.busy,
        onChange: props.onTypedChange,
      }) : null,
      props.error ? ErrorPanel({
        title: props.error.title || 'Not done',
        message: props.error.message,
        code: props.error.code,
        requestId: props.error.requestId,
      }) : null,
    ],
    actions: [
      Button({ label: props.cancelLabel || 'Cancel', variant: 'ghost', disabled: props.busy, onClick: props.onCancel, attrs: { 'data-dialog-cancel': 'true' } }),
      Button({ label: props.confirmLabel, variant: 'danger', busy: props.busy, disabled: !typedOk, onClick: props.onConfirm, attrs: { 'data-dialog-confirm': 'true' } }),
    ],
  });
}

// ---- Evidence (PR5) -------------------------------------------------------

/// What a record shows and on what basis (contract §5, §7.9). Each claim has
/// its own label and value. A claim the product checked carries its
/// verification, shown with VerificationBadge; a claim without one is a
/// recorded fact, and the summary says so instead of implying it was checked.
function EvidenceSummary(props) {
  const id = idPart(props.id || 'stack-evidence');
  const claims = (props.claims || []).filter((claim) => claim && present(claim.label));
  // A claim counts as checked only when a check was made: verified, failed,
  // or not verified. "Not evaluated" (including "verified" with no check
  // listed) is a record, like a claim with no verification at all.
  const states = claims.map((claim) => (present(claim.verification) ? verification(claim.verification, claim.checks).state : 'not_evaluated'));
  const checked = states.filter((value) => value !== 'not_evaluated');
  const verified = checked.filter((value) => value === 'verified').length;
  const failed = checked.filter((value) => value === 'verification_failed').length;
  const recorded = states.length - checked.length;
  const state = checked.length === 0 ? 'recorded' : verified === checked.length && recorded === 0 ? 'verified' : 'partial';
  const recordedNote = recorded ? ` · ${recorded} recorded, not checked` : '';
  const summary = state === 'recorded'
    ? 'Recorded facts · not independently verified'
    : state === 'verified'
      ? (checked.length === 1 ? 'Verified' : `All ${checked.length} claims verified`)
      : `${verified} of ${checked.length} checked claims verified${failed ? ` · ${failed} failed` : ''}${recordedNote}`;
  return node('section', {
    class: cx('stack-evidence', `stack-evidence--${state}`, props.className),
    'aria-labelledby': `${id}-title`,
    'data-evidence': state,
    ...passthrough(props.attrs),
  }, [
    node('div', { class: 'stack-evidence__header' }, [
      node(heading(props.headingLevel || 2), { class: 'stack-evidence__title', id: `${id}-title` }, present(props.title) ? props.title : 'Evidence'),
      props.outcome ? node('div', { class: 'stack-evidence__outcome' }, props.outcome) : null,
    ]),
    node('p', { class: 'stack-evidence__summary' }, summary),
    claims.length ? node('dl', { class: 'stack-evidence__claims' }, claims.map((claim) => {
      const missing = !present(claim.value) && claim.value !== 0 && claim.value !== false;
      return node('div', {
        class: 'stack-evidence__claim',
        ...(present(claim.verification) ? { 'data-verification': verification(claim.verification, claim.checks).state } : {}),
        ...passthrough(claim.attrs),
      }, [
        node('dt', { class: 'stack-evidence__label' }, claim.label),
        node('dd', {
          class: cx('stack-evidence__value', claim.mono ? 'stack-evidence__value--mono' : null),
          ...(missing ? { 'data-missing': 'true' } : {}),
        }, missing ? '—' : (typeof claim.value === 'boolean' ? String(claim.value) : claim.value)),
        present(claim.verification) ? node('dd', { class: 'stack-evidence__check' }, VerificationBadge({
          state: claim.verification, checks: claim.checks, evidenceHref: claim.evidenceHref,
        })) : null,
      ]);
    })) : null,
    present(props.source) || present(props.recordedAt)
      ? node('p', { class: 'stack-evidence__source' }, [
        present(props.source) ? props.source : 'Recorded',
        present(props.recordedAt) ? [' · ', timeNode(props.recordedAt, 'stack-evidence__at')] : null,
      ])
      : null,
  ]);
}

// ---- Notices, choices and history (0.6.0) ------------------------------------

const ALERT_TONES = ['info', 'attention', 'critical'];
const ALERT_GLYPHS = { info: 'i', attention: '▲', critical: '✕' };

/// A persistent page-level notice (contract §5). Critical notices interrupt
/// (role=alert); info and attention are announced politely (role=status).
/// Information is not a state: an Alert never stands in for a StatusIndicator.
function Alert(props) {
  const tone = ALERT_TONES.includes(props.tone) ? props.tone : 'info';
  return node('div', {
    class: cx('stack-alert', `stack-alert--${tone}`, props.className),
    role: tone === 'critical' ? 'alert' : 'status',
    'data-tone': tone,
    ...passthrough(props.attrs),
  }, [
    node('span', { class: 'stack-alert__glyph', 'aria-hidden': 'true' }, ALERT_GLYPHS[tone]),
    node('div', { class: 'stack-alert__content' }, [
      present(props.title) ? node('p', { class: 'stack-alert__title' }, props.title) : null,
      props.children ? node('div', { class: 'stack-alert__body' }, props.children) : null,
      props.actions ? node('div', { class: 'stack-alert__actions' }, props.actions) : null,
    ]),
  ]);
}

/// One labelled checkbox. The label is the control's name and is always
/// visible; hint and error are described by id, as for every field.
/// `onChange(checked)` is called on every change; without it the box is
/// uncontrolled and a form reads it on submit.
function Checkbox(props) {
  const id = fieldId(props);
  const given = props.checked !== undefined && props.checked !== null;
  const control = node('input', {
    class: 'stack-checkbox__control',
    type: 'checkbox',
    id,
    ...(present(props.name) ? { name: props.name } : {}),
    ...(present(props.value) ? { value: String(props.value) } : {}),
    ...(given && props.checked ? { checked: true } : {}),
    ...controlState(props, id),
  }, [], props.onChange ? { change: (event) => props.onChange(Boolean(event.target.checked)) } : undefined);
  return node('div', {
    class: cx('stack-checkbox', props.error ? 'stack-checkbox--invalid' : null, props.className),
    ...passthrough(props.attrs),
  }, [
    node('div', { class: 'stack-checkbox__row' }, [
      control,
      node('label', { class: 'stack-checkbox__label', for: id }, [
        props.label,
        props.required ? node('span', { class: 'stack-field__required', 'aria-hidden': 'true' }, ' *') : null,
      ]),
    ]),
    present(props.hint) ? node('p', { class: 'stack-field__hint', id: `${id}-hint` }, props.hint) : null,
    present(props.error) ? node('p', { class: 'stack-field__error', id: `${id}-error` }, props.error) : null,
  ]);
}

/// Related controls under one visible legend (a set of checkboxes, a pair of
/// fields). The legend names the group for assistive technology; a group
/// error is described on the fieldset.
function FieldGroup(props) {
  const id = idPart(props.id || 'stack-group');
  const described = [present(props.hint) ? `${id}-hint` : null, present(props.error) ? `${id}-error` : null].filter(Boolean);
  return node('fieldset', {
    class: cx('stack-fieldgroup', props.error ? 'stack-fieldgroup--invalid' : null, props.className),
    id,
    ...(described.length ? { 'aria-describedby': described.join(' ') } : {}),
    ...(props.disabled ? { disabled: true } : {}),
    ...passthrough(props.attrs),
  }, [
    node('legend', { class: 'stack-fieldgroup__legend' }, [
      props.legend,
      props.required ? node('span', { class: 'stack-field__required', 'aria-hidden': 'true' }, ' *') : null,
    ]),
    present(props.hint) ? node('p', { class: 'stack-field__hint', id: `${id}-hint` }, props.hint) : null,
    node('div', { class: 'stack-fieldgroup__controls' }, props.children || null),
    present(props.error) ? node('p', { class: 'stack-field__error', id: `${id}-error` }, props.error) : null,
  ]);
}

/// Events, audit records and history, newest first as the product orders
/// them (contract §5, §7.9). Each item has a time; `actor`, `status`,
/// `detail` and `href` are optional. `hasMore` says older activity exists
/// instead of implying the list is complete. Loading, error and empty are
/// part of the timeline, as they are of DataTable.
function ActivityTimeline(props) {
  const items = (props.items || []).filter((item) => item && present(item.summary));
  const label = present(props.label) ? props.label : 'Activity';
  let body;
  // `error` is the product's message, or { title, message, code, requestId, onRetry }.
  if (props.error) body = ErrorPanel(typeof props.error === 'string' ? { message: props.error } : props.error);
  else if (props.loading && !items.length) body = Loading({ what: present(props.what) ? props.what : 'activity' });
  else if (!items.length) body = EmptyState({ title: present(props.emptyTitle) ? props.emptyTitle : 'No activity recorded', headingLevel: props.headingLevel || 3 });
  else {
    body = node('ol', { class: 'stack-timeline__list', 'aria-label': label }, items.map((item, index) => node('li', {
      class: 'stack-timeline__item',
      ...passthrough(item.attrs),
    }, [
      node('span', { class: 'stack-timeline__marker', 'aria-hidden': 'true' }),
      node('div', { class: 'stack-timeline__content' }, [
        node('p', { class: 'stack-timeline__summary' }, present(item.href)
          ? node('a', { class: 'stack-timeline__link', href: item.href }, item.summary)
          : item.summary),
        node('p', { class: 'stack-timeline__meta' }, [
          present(item.at) ? timeNode(item.at, 'stack-timeline__at') : node('span', { class: 'stack-timeline__at', 'data-missing': 'true' }, 'Time not recorded'),
          present(item.actor) ? [' · ', node('span', { class: 'stack-timeline__actor' }, item.actor)] : null,
          item.status ? [' ', node('span', { class: 'stack-timeline__status' }, item.status)] : null,
        ]),
        item.detail ? node('div', { class: 'stack-timeline__detail' }, item.detail) : null,
      ]),
    ], undefined, present(item.id) ? item.id : index)));
  }
  return node('section', {
    class: cx('stack-timeline', props.className),
    ...(props.loading ? { 'aria-busy': 'true' } : {}),
    ...passthrough(props.attrs),
  }, [
    body,
    props.hasMore && items.length ? node('p', { class: 'stack-timeline__more' }, [
      present(props.moreHref)
        ? node('a', { href: props.moreHref, class: 'stack-timeline__link' }, props.moreLabel || 'Older activity exists')
        : (props.onMore ? Button({ label: props.moreLabel || 'Load older activity', onClick: props.onMore, busy: Boolean(props.loading) }) : (props.moreLabel || 'Older activity exists')),
    ]) : null,
  ]);
}

// ---- Brand and marketing foundation (0.6.0, docs/brand.md) --------------------

/// The Boundry mark: two bands forming a B, drawn from the company mark
/// tokens so it follows the theme. Decorative unless given a `title`.
function BrandMark(props) {
  const id = idPart(props.idPrefix || 'stack-brand-mark');
  const titled = present(props.title);
  return node('svg', {
    class: cx('stack-brand-mark', props.className),
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: '0 0 340 315',
    focusable: 'false',
    ...(titled ? { role: 'img', 'aria-labelledby': `${id}-title` } : { 'aria-hidden': 'true' }),
    ...passthrough(props.attrs),
  }, [
    titled ? node('title', { id: `${id}-title` }, props.title) : null,
    node('defs', {}, node('linearGradient', { id: `${id}-fill`, x1: '0', y1: '0', x2: '340', y2: '0', gradientUnits: 'userSpaceOnUse' }, [
      node('stop', { class: 'stack-brand-mark__start', offset: '0.2' }),
      node('stop', { class: 'stack-brand-mark__end', offset: '0.85' }),
    ])),
    node('path', { fill: `url(#${id}-fill)`, d: 'M0 0H250C298 0 330 38 329 84C328 114 309 135 281 143L0 269V182L225 80H0Z' }),
    node('path', { fill: `url(#${id}-fill)`, d: 'M0 315L290 182C318 172 341 202 340 246C339 288 306 315 268 315Z' }),
  ]);
}

/// The theme control every site and product uses: System (the default,
/// following the operating system), Light or Dark. `onChange(preference)`
/// normally calls setThemePreference from theme.js.
function ThemeSwitch(props) {
  const id = idPart(props.id || 'stack-theme');
  return node('div', { class: cx('stack-theme-switch', props.className), ...passthrough(props.attrs) }, [
    node('label', { class: 'stack-visually-hidden', for: id }, props.label || 'Theme'),
    node('select', { class: 'stack-theme-switch__control', id, 'data-stack-theme-control': '' },
      THEME_OPTIONS.map((option) => node('option', {
        value: option.value, ...(option.value === (props.preference || 'system') ? { selected: true } : {}),
      }, option.label)), props.onChange ? { change: (event) => props.onChange(event.target.value) } : undefined),
  ]);
}

const productOf = (props) => (props.product ? { ...(portfolioProduct(props.product.id) || {}), ...props.product } : null);

/// Header for a company or product website. The product's identity leads; a
/// product site also carries "A Boundry product" linking to boundry.company.
/// Navigation is ordinary links (it works without JavaScript) and wraps into
/// a scrollable row on narrow screens instead of hiding behind a menu.
function SiteHeader(props) {
  const company = PORTFOLIO.company;
  const product = productOf(props);
  const name = product ? product.name : company.name;
  const homeHref = present(props.homeHref) ? props.homeHref : '/';
  return node('header', {
    class: cx('stack-site-header', props.className),
    ...(product && present(product.id) ? { 'data-stack-product': product.id } : {}),
    ...passthrough(props.attrs),
  }, [
    node('a', { class: 'stack-site-header__skip', href: `#${idPart(props.mainId || 'main')}` }, props.skipLabel || 'Skip to content'),
    node('div', { class: 'stack-site-header__inner' }, [
      node('div', { class: 'stack-site-header__identity' }, [
        node('a', { class: 'stack-site-header__home', href: homeHref, 'aria-label': `${name} home` }, [
          props.logo ? node('span', { class: 'stack-site-header__logo' }, props.logo)
            : product ? node('span', { class: 'stack-site-header__product-mark', 'aria-hidden': 'true' }, product.mark || name.slice(0, 2))
              : BrandMark({ className: 'stack-site-header__logo', idPrefix: `${idPart(props.mainId || 'main')}-mark` }),
          node('span', { class: 'stack-site-header__name' }, name),
        ]),
        product ? node('a', { class: 'stack-site-header__family', href: company.href }, ['A ', company.name, ' product']) : null,
      ]),
      (props.navigation || []).length ? node('nav', { class: 'stack-site-header__nav', 'aria-label': props.navigationLabel || 'Main' },
        node('ul', { class: 'stack-site-header__nav-list' }, props.navigation.map((item) => node('li', {}, node('a', {
          class: 'stack-site-header__nav-item',
          href: item.href,
          ...(item.current ? { 'aria-current': 'page' } : {}),
          ...passthrough(item.attrs),
        }, item.label))))) : null,
      node('div', { class: 'stack-site-header__end' }, [
        props.theme ? ThemeSwitch({ id: `${idPart(props.mainId || 'main')}-theme`, preference: props.theme.preference, onChange: props.theme.onChange }) : null,
        props.actions || null,
      ]),
    ]),
  ]);
}

/// Footer for a company or product website: the product's own link columns,
/// then the Boundry family — every product, the current one marked, and a
/// link to boundry.company — and the legal line.
function SiteFooter(props) {
  const company = PORTFOLIO.company;
  const product = productOf(props);
  const columns = props.columns || [];
  const year = present(props.year) ? props.year : null;
  const owner = present(props.owner) ? props.owner : company.name;
  return node('footer', {
    class: cx('stack-site-footer', props.className),
    ...(product && present(product.id) ? { 'data-stack-product': product.id } : {}),
    ...passthrough(props.attrs),
  }, node('div', { class: 'stack-site-footer__inner' }, [
    node('div', { class: 'stack-site-footer__top' }, [
      node('div', { class: 'stack-site-footer__about' }, [
        node('p', { class: 'stack-site-footer__name' }, product ? product.name : company.name),
        present(props.tagline) ? node('p', { class: 'stack-site-footer__tagline' }, props.tagline) : null,
      ]),
      columns.map((column) => node('nav', { class: 'stack-site-footer__column', 'aria-label': column.title }, [
        node('p', { class: 'stack-site-footer__heading' }, column.title),
        node('ul', { class: 'stack-site-footer__list' }, (column.links || []).map((link) => node('li', {}, node('a', {
          class: 'stack-site-footer__link', href: link.href, ...passthrough(link.attrs),
        }, link.label)))),
      ])),
    ]),
    node('nav', { class: 'stack-site-footer__family', 'aria-label': `${company.name} products` }, [
      node('a', { class: 'stack-site-footer__company', href: company.href }, [
        BrandMark({ className: 'stack-site-footer__mark', idPrefix: `${idPart(props.id || 'stack-footer')}-mark` }),
        node('span', {}, product ? company.family : `${company.name} — ${company.tagline}`),
      ]),
      node('ul', { class: 'stack-site-footer__products' }, PORTFOLIO.products.map((entry) => node('li', {
        'data-stack-product': entry.id,
      }, node('a', {
        class: 'stack-site-footer__product',
        href: entry.href,
        ...(product && product.id === entry.id ? { 'aria-current': 'true' } : {}),
      }, [
        node('span', { class: 'stack-site-footer__product-name' }, entry.name),
        node('span', { class: 'stack-site-footer__product-category' }, entry.category),
      ])))),
    ]),
    node('p', { class: 'stack-site-footer__legal' }, [
      `© ${year ? `${year} ` : ''}${owner}`,
      product ? [' · ', product.name, ' is a ', node('a', { href: company.href }, `${company.name} product`)] : null,
      props.legal ? [' · ', props.legal] : null,
    ]),
  ]));
}

const COMPONENTS = Object.freeze({
  Breadcrumbs, Tabs, TabPanel, DataTable, FilterBar, Pagination, Shell,
  StatusIndicator, VerificationBadge, FreshnessLabel, Unavailable, Loading, EmptyState,
  ErrorPanel, MetadataList, ResourceIdentity, PageHeader, Button,
  TextField, Select, Form, Dialog, ConfirmAction, EvidenceSummary,
  Alert, Checkbox, FieldGroup, ActivityTimeline,
  BrandMark, ThemeSwitch, SiteHeader, SiteFooter,
});

// ---- charts.js
// Charts as view trees (docs/charts.md). Native SVG, no dependencies: every
// renderer (dom.js, html.js, the React binding, the classic build) draws the
// same structure, so a chart looks and behaves the same in every product.
//
// Charts present numbers a product has already computed. They never compute
// authoritative values: they position marks, sum stacks to place them, and
// format text. Inputs are validated and never mutated.
//
// Interaction needs no script: each category (or slice) is a focusable mark
// whose tooltip CSS shows on hover and keyboard focus. Every chart also carries
// its data as a table, so nothing is conveyed only by colour or by pointer.
//
// Names in this file are prefixed (ch*) because the classic build places every
// core source in one scope (scripts/build.mjs).


const chNode = (t, a, c, k) => ({ t, a: a || {}, c: c === undefined ? [] : [].concat(c), ...(k === undefined || k === null ? {} : { k: String(k) }) });
const chCx = (...names) => names.filter(Boolean).join(' ');
const chPresent = (value) => value !== null && value !== undefined && value !== '';
const chPassthrough = (attrs) => {
  const out = {};
  for (const [key, value] of Object.entries(attrs || {})) {
    if (/^(data-|aria-)/.test(key) || key === 'id' || key === 'title') out[key] = value;
  }
  return out;
};
/// Coordinates with two decimals: identical text in every renderer.
const chR = (value) => Math.round(value * 100) / 100;

/// Number of series colours in the palette (--stack-color-chart-1 … -8).
const CHART_PALETTE_SIZE = 8;
const CH_FONT = 12;
const CH_CHAR = 0.6;
const CH_DEFAULT_WIDTH = 640;
const CH_MAX_FOCUSABLE = 60;
const CH_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// Estimated width of a label at the chart font size. Deterministic: layout must
/// not depend on font metrics that differ between renderers and machines.
const chTextWidth = (text, size = CH_FONT) => String(text).length * size * CH_CHAR;
const chFit = (text, width, size = CH_FONT) => {
  const s = String(text);
  if (chTextWidth(s, size) <= width) return s;
  const keep = Math.max(1, Math.floor(width / (size * CH_CHAR)) - 1);
  return `${s.slice(0, keep)}…`;
};

// ---- Formatting ---------------------------------------------------------------

const CH_CURRENCY = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CAD: 'CA$', AUD: 'A$', NZD: 'NZ$', CHF: 'CHF ', INR: '₹', CNY: 'CN¥', MXN: 'MX$', BRL: 'R$' };
const CH_ZERO_DECIMAL = new Set(['JPY']);
const CH_COMPACT = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];

/// en-US digits for a non-negative number: comma groups, rounded half away from
/// zero to `max` decimals, trailing zeros trimmed down to `min`.
function chDigits(abs, min, max) {
  const factor = 10 ** max;
  const scaled = Math.round(abs * factor + abs * factor * Number.EPSILON);
  const whole = Math.floor(scaled / factor);
  let frac = max ? String(scaled - whole * factor).padStart(max, '0') : '';
  while (frac.length > min && frac.endsWith('0')) frac = frac.slice(0, -1);
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

/// Text for a value: a function, or { style: 'number'|'currency'|'percent',
/// currency, divisor, minimumFractionDigits, maximumFractionDigits, compact,
/// suffix }. Written in en-US without Intl, so the text (and the layout that
/// depends on it) is identical in every renderer, browser and Node version.
/// `divisor` changes only the presentation (minor units to major units);
/// percent expects fractions (0.25 → 25%). Missing values are "—".
function formatChartValue(value, format) {
  if (value === null || value === undefined) return '—';
  if (typeof format === 'function') return String(format(value));
  const f = format || {};
  const style = f.style === 'currency' || f.style === 'percent' ? f.style : 'number';
  let shown = f.divisor ? value / f.divisor : value;
  if (style === 'percent') shown *= 100;
  const negative = shown < 0;
  let abs = Math.abs(shown);
  const code = f.currency || 'USD';
  const base = style === 'currency' ? (CH_ZERO_DECIMAL.has(code) ? 0 : 2) : style === 'percent' ? 1 : 2;
  let max = f.maximumFractionDigits !== undefined ? f.maximumFractionDigits : base;
  let min = f.minimumFractionDigits !== undefined ? f.minimumFractionDigits : (style === 'currency' ? Math.min(base, max) : 0);
  let unit = '';
  if (f.compact) {
    max = f.maximumFractionDigits !== undefined ? f.maximumFractionDigits : 1;
    min = 0;
    // The largest unit the value still shows at least 1 of once rounded (999.95 → 1K).
    const factor = 10 ** max;
    const step = CH_COMPACT.find(([size]) => Math.round((abs / size) * factor) >= factor);
    if (step) { abs /= step[0]; unit = step[1]; }
  }
  if (max < min) max = min;
  let digits = chDigits(abs, min, max);
  if (digits.replace(/[0.,]/g, '') === '') digits = chDigits(0, min, max);
  const zero = digits.replace(/[0.,]/g, '') === '';
  const sign = negative && !zero ? '-' : '';
  const symbol = style === 'currency' ? (CH_CURRENCY[code] || `${code} `) : '';
  return `${sign}${symbol}${digits}${unit}${style === 'percent' ? '%' : ''}${f.suffix || ''}`;
}

const chIsoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
/// Time labels in UTC: "Jan 2026" when every point is the first of a month, else "2026-01-15".
const chTimeFormatter = (values) => {
  const monthly = values.every((ms) => { const d = new Date(ms); return d.getUTCDate() === 1 && d.getUTCHours() === 0; });
  return monthly ? (ms) => { const d = new Date(ms); return `${CH_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; } : chIsoDay;
};

// ---- Validation and normalization ---------------------------------------------

const chFail = (kind, message) => { throw new TypeError(`${kind}: ${message}`); };

function chToTime(kind, x) {
  const ms = typeof x === 'number' ? x : Date.parse(x);
  if (!Number.isFinite(ms)) chFail(kind, `x value ${JSON.stringify(x)} is not a time (use epoch milliseconds or an ISO date)`);
  return ms;
}

/// Checks the series contract and builds the chart's table: ordered x keys and
/// one value per series per key (null where a series has no value). Throws a
/// TypeError naming the problem for input a chart cannot represent faithfully.
function normalizeSeries(kind, series, xType = 'category') {
  if (!Array.isArray(series)) chFail(kind, 'series must be an array');
  if (!['category', 'time', 'number'].includes(xType)) chFail(kind, `xType must be "category", "time" or "number", not ${JSON.stringify(xType)}`);
  const ids = new Set();
  const keys = [];
  const index = new Map();
  const rows = series.map((s, i) => {
    if (!s || typeof s !== 'object') chFail(kind, `series[${i}] must be an object`);
    if (typeof s.id !== 'string' || !s.id) chFail(kind, `series[${i}] needs a non-empty string id`);
    if (ids.has(s.id)) chFail(kind, `series id "${s.id}" is used twice`);
    ids.add(s.id);
    if (typeof s.label !== 'string' || !s.label) chFail(kind, `series "${s.id}" needs a label`);
    if (!Array.isArray(s.data)) chFail(kind, `series "${s.id}" data must be an array`);
    const seen = new Set();
    const values = new Map();
    s.data.forEach((p, j) => {
      if (!p || typeof p !== 'object') chFail(kind, `series "${s.id}" point ${j} must be an object`);
      const okX = typeof p.x === 'string' || (typeof p.x === 'number' && Number.isFinite(p.x));
      if (!okX) chFail(kind, `series "${s.id}" point ${j} has an invalid x`);
      if (!(p.y === null || (typeof p.y === 'number' && Number.isFinite(p.y)))) {
        chFail(kind, `series "${s.id}" point ${j} y must be a finite number or null, not ${JSON.stringify(p.y)}`);
      }
      let key;
      if (xType === 'time') key = chToTime(kind, p.x);
      else if (xType === 'number') {
        if (typeof p.x !== 'number') chFail(kind, `series "${s.id}" point ${j} x must be a number for xType "number"`);
        key = p.x;
      } else key = String(p.x);
      if (seen.has(key)) chFail(kind, `series "${s.id}" has two points at x ${JSON.stringify(p.x)}`);
      seen.add(key);
      values.set(key, p.y);
      if (!index.has(key)) { index.set(key, keys.length); keys.push(key); }
    });
    const palette = Number.isInteger(s.palette) && s.palette >= 1 && s.palette <= CHART_PALETTE_SIZE ? s.palette : (i % CHART_PALETTE_SIZE) + 1;
    return { id: s.id, label: s.label, hidden: Boolean(s.hidden), palette, dash: i % 4, values };
  });
  if (xType !== 'category') keys.sort((a, b) => a - b);
  return {
    keys,
    series: rows.map((r) => ({ ...r, y: keys.map((k) => (r.values.has(k) ? r.values.get(k) : null)) })),
  };
}

// ---- Scales -------------------------------------------------------------------

/// Round tick values covering [min, max] in steps of 1, 2 or 5 × 10^k.
function niceTicks(min, max, count = 5) {
  if (!(Number.isFinite(min) && Number.isFinite(max))) return { min: 0, max: 1, ticks: [0, 1] };
  if (min === max) {
    if (min === 0) return { min: 0, max: 1, ticks: [0, 0.5, 1] };
    const pad = Math.abs(min) * 0.5;
    return niceTicks(Math.min(0, min - pad), Math.max(0, max + pad), count);
  }
  const span = max - min;
  const raw = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => span / s <= count) || 10 * magnitude;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.abs(v) < step / 1e6 ? 0 : Number(v.toPrecision(12)));
  return { min: lo, max: hi, ticks };
}

const chLinear = (d0, d1, r0, r1) => (v) => (d1 === d0 ? (r0 + r1) / 2 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0));

// ---- Shared structure ---------------------------------------------------------

const chSize = (props, defaults) => {
  const width = Math.max(120, Math.round(Number(props.width) || CH_DEFAULT_WIDTH));
  const ratio = Number(props.aspectRatio) > 0 ? Number(props.aspectRatio) : defaults.aspectRatio;
  const height = Math.round(Number(props.height) > 0 ? Number(props.height) : Math.min(defaults.maxHeight, Math.max(defaults.minHeight, width / ratio)));
  return { width, height };
};

function chFigure(kind, props, body) {
  const busy = Boolean(props.loading);
  return chNode('figure', {
    class: chCx('stack-chart', `stack-chart--${kind}`, props.className),
    'data-chart': kind,
    'data-chart-state': body.state,
    ...(busy ? { 'aria-busy': 'true' } : {}),
    ...chPassthrough(props.attrs),
  }, [
    chNode('figcaption', { class: 'stack-chart__header' }, [
      props.headingLevel
        ? chNode(`h${Math.min(6, Math.max(1, Number(props.headingLevel) || 3))}`, { class: 'stack-chart__title' }, props.title)
        : chNode('span', { class: 'stack-chart__title' }, props.title),
      chPresent(props.description) ? chNode('span', { class: 'stack-chart__description' }, props.description) : null,
    ]),
    body.content,
  ]);
}

/// The loading, error and empty states every chart shares, or null when ready.
function chState(kind, props, hasData) {
  if (props.error) {
    const e = typeof props.error === 'string' ? { message: props.error } : props.error;
    return { state: 'error', content: chNode('div', { class: 'stack-chart__state' }, ErrorPanel({ title: props.errorTitle || 'Could not show this chart', message: e.message, code: e.code, requestId: e.requestId, onRetry: props.onRetry })) };
  }
  if (props.loading) return { state: 'loading', content: chNode('div', { class: 'stack-chart__state' }, Loading({ what: props.loadingWhat || 'chart data', long: props.loadingLong })) };
  if (!hasData) {
    return { state: 'empty', content: chNode('div', { class: 'stack-chart__state' }, EmptyState({ title: props.emptyTitle || 'No data to show', body: props.emptyBody, headingLevel: (Number(props.headingLevel) || 2) + 1 })) };
  }
  return null;
}

function chLegend(kind, rows, props) {
  const toggle = typeof props.onToggleSeries === 'function' ? props.onToggleSeries : null;
  return chNode('ul', { class: 'stack-chart__legend', 'aria-label': props.legendLabel || 'Series' }, rows.map((r) => {
    const swatch = chNode('span', { class: chCx('stack-chart__swatch', kind === 'line' || kind === 'sparkline' ? 'stack-chart__swatch--line' : null, `stack-chart__s${r.palette}`, `stack-chart__d${r.dash}`), 'aria-hidden': 'true' });
    const content = [swatch, chNode('span', { class: 'stack-chart__legend-label' }, r.label), r.note ? chNode('span', { class: 'stack-chart__legend-note' }, r.note) : null];
    const item = toggle
      ? { ...chNode('button', { type: 'button', class: 'stack-chart__legend-toggle', 'aria-pressed': r.hidden ? 'false' : 'true' }, content), on: { click: () => toggle(r.id) } }
      : content;
    return chNode('li', { class: chCx('stack-chart__legend-item', r.hidden ? 'stack-chart__legend-item--hidden' : null), 'data-series': r.id }, item, r.id);
  }));
}

function chTable(props, columns, rows) {
  const open = props.table === 'visible';
  const head = chNode('thead', {}, chNode('tr', {}, columns.map((c, i) => chNode('th', { scope: 'col', class: i ? 'stack-chart__num' : null }, c, i))));
  const body = chNode('tbody', {}, rows.map((r, i) => chNode('tr', {}, r.map((cell, j) => (j === 0
    ? chNode('th', { scope: 'row' }, cell, j)
    : chNode('td', { class: 'stack-chart__num', ...(cell === '—' ? { 'data-missing': 'true' } : {}) }, cell, j))), i)));
  const table = chNode('div', { class: 'stack-chart__table-wrap' }, chNode('table', { class: 'stack-chart__table' }, [
    chNode('caption', { class: 'stack-visually-hidden' }, props.title), head, body,
  ]));
  if (props.table === 'none') return null;
  return chNode('details', { class: 'stack-chart__data', ...(open ? { open: true } : {}) }, [
    chNode('summary', { class: 'stack-chart__data-summary' }, props.tableLabel || 'Data table'), table,
  ]);
}

/// A tooltip box: a heading row and value rows, kept inside [0, width].
function chTooltip(anchorX, top, width, heading, rows) {
  const lineH = 16;
  const pad = 8;
  const textW = Math.max(chTextWidth(heading), ...rows.map((r) => chTextWidth(r.text) + (r.palette ? 14 : 0)));
  const boxW = Math.min(width - 4, textW + pad * 2);
  const boxH = pad * 2 + lineH * (rows.length + 1) - 4;
  let x = anchorX + 10;
  if (x + boxW > width - 2) x = anchorX - 10 - boxW;
  if (x < 2) x = 2;
  const inner = boxW - pad * 2;
  return chNode('g', { class: 'stack-chart__tip', 'aria-hidden': 'true' }, [
    chNode('rect', { class: 'stack-chart__tip-box', x: chR(x), y: chR(top), width: chR(boxW), height: chR(boxH), rx: 4 }),
    chNode('text', { class: 'stack-chart__tip-title', x: chR(x + pad), y: chR(top + pad + 10) }, chFit(heading, inner)),
    rows.map((r, i) => [
      r.palette ? chNode('rect', { class: chCx('stack-chart__tip-swatch', `stack-chart__s${r.palette}`), x: chR(x + pad), y: chR(top + pad + lineH * (i + 1) + 1), width: 9, height: 9, rx: 2 }, [], `s${i}`) : null,
      chNode('text', { class: 'stack-chart__tip-row', x: chR(x + pad + (r.palette ? 14 : 0)), y: chR(top + pad + lineH * (i + 1) + 10) }, chFit(r.text, inner - (r.palette ? 14 : 0)), `t${i}`),
    ]),
  ]);
}

// ---- Cartesian charts (line, area, bar) ---------------------------------------

function chXLabels(normalized, xType, props) {
  if (typeof props.xFormat === 'function') return normalized.keys.map((k) => String(props.xFormat(k)));
  if (xType === 'time') { const f = chTimeFormatter(normalized.keys); return normalized.keys.map(f); }
  if (xType === 'number') return normalized.keys.map((k) => formatChartValue(k, props.xFormat));
  return normalized.keys.map(String);
}

const chAxisFormat = (props, extent) => props.axisFormat
  || (props.format && typeof props.format === 'object' && Math.max(Math.abs(extent.min), Math.abs(extent.max)) >= 10000 ? { ...props.format, compact: true, minimumFractionDigits: undefined, maximumFractionDigits: undefined } : props.format);

/// Value extent of what is drawn: grouped values, or the positive and negative stacks.
function chExtent(rows, n, stacked, zero) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    if (stacked) {
      let pos = 0;
      let neg = 0;
      for (const r of rows) { const v = r.y[i]; if (v === null) continue; if (v >= 0) pos += v; else neg += v; }
      max = Math.max(max, pos); min = Math.min(min, neg);
    } else {
      for (const r of rows) { const v = r.y[i]; if (v === null) continue; max = Math.max(max, v); min = Math.min(min, v); }
    }
  }
  if (zero) { min = Math.min(min, 0); max = Math.max(max, 0); }
  return { min, max };
}

/// Lower and upper value of each series at each x when stacked (positives up, negatives down).
function chStack(rows, n) {
  const pos = new Array(n).fill(0);
  const neg = new Array(n).fill(0);
  return rows.map((r) => r.y.map((v, i) => {
    if (v === null) return null;
    if (v >= 0) { const lo = pos[i]; pos[i] += v; return [lo, pos[i]]; }
    const hi = neg[i]; neg[i] += v; return [neg[i], hi];
  }));
}

function cartesian(kind, props) {
  const xType = props.xType || 'category';
  const normalized = normalizeSeries(kindName(kind), props.series, xType);
  const all = normalized.series;
  const rows = all.filter((r) => !r.hidden);
  const n = normalized.keys.length;
  const hasData = rows.some((r) => r.y.some((v) => v !== null));
  const pending = chState(kind, props, hasData);
  const legendRows = all.map((r) => ({ id: r.id, label: r.label, palette: r.palette, dash: r.dash, hidden: r.hidden }));
  const showLegend = props.legend === false ? false : (props.legend === true || all.length > 1);
  if (pending) return chFigure(kind, props, { state: pending.state, content: [showLegend && pending.state === 'empty' ? chLegend(kind, legendRows, props) : null, pending.content] });

  const horizontal = kind === 'bar' && props.orientation === 'horizontal';
  const stacked = Boolean(props.stacked);
  const bars = kind === 'bar';
  // Horizontal bars grow with the number of categories, not the width.
  const rowHeight = stacked ? 30 : Math.max(24, 12 * rows.length + 12);
  const fitted = Math.max(120, n * rowHeight + 48);
  const { width, height } = chSize(props, horizontal
    ? { aspectRatio: 0.01, minHeight: fitted, maxHeight: fitted }
    : { aspectRatio: 2, minHeight: 180, maxHeight: 420 });
  const xLabels = chXLabels(normalized, xType, props);
  const zero = kind !== 'line' || props.zeroBaseline !== false;
  const extent = chExtent(rows, n, stacked, zero);
  const valueSpan = horizontal ? width : height;
  const scaleTicks = niceTicks(extent.min, extent.max, Math.max(2, Math.min(8, Math.floor(valueSpan / (horizontal ? 90 : 48)))));
  const axisFmt = chAxisFormat(props, extent);
  const tickText = scaleTicks.ticks.map((t) => formatChartValue(t, axisFmt));
  const font = CH_FONT;

  // Margins from the labels they hold, so nothing is clipped.
  const yLabelSpace = props.yLabel ? font + 8 : 0;
  const xLabelSpace = props.xLabel ? font + 10 : 0;
  let left;
  let bottom;
  const top = 10;
  let right = 12;
  if (horizontal) {
    const longest = Math.max(...xLabels.map((l) => chTextWidth(l)));
    left = Math.round(Math.min(width * 0.4, longest + 12) + yLabelSpace);
    bottom = font + 12 + xLabelSpace;
    right = Math.round(Math.max(12, chTextWidth(tickText[tickText.length - 1]) / 2 + 4));
  } else {
    left = Math.round(Math.max(...tickText.map((t) => chTextWidth(t))) + 12 + yLabelSpace);
    bottom = font + 14 + xLabelSpace;
    if (!bars && xType !== 'category' && n) right = Math.round(Math.max(12, chTextWidth(xLabels[n - 1]) / 2 + 4));
  }
  const plot = { x0: left, x1: Math.max(left + 20, width - right), y0: top, y1: Math.max(top + 20, height - bottom) };
  const plotW = plot.x1 - plot.x0;
  const plotH = plot.y1 - plot.y0;

  // Scales: value axis and category/position axis.
  const value = horizontal ? chLinear(scaleTicks.min, scaleTicks.max, plot.x0, plot.x1) : chLinear(scaleTicks.min, scaleTicks.max, plot.y1, plot.y0);
  const band = (horizontal ? plotH : plotW) / Math.max(1, n);
  let position;
  if (bars || xType === 'category') {
    position = (i) => (horizontal ? plot.y0 : plot.x0) + band * (i + 0.5);
  } else {
    const lin = chLinear(normalized.keys[0], normalized.keys[n - 1], plot.x0, plot.x1);
    position = (i) => lin(normalized.keys[i]);
  }

  const parts = [];
  // Grid and value axis.
  const grid = props.grid !== false;
  parts.push(chNode('g', { class: 'stack-chart__axis stack-chart__axis--value', 'aria-hidden': 'true' }, scaleTicks.ticks.map((t, i) => {
    const p = chR(value(t));
    return [
      grid ? chNode('line', horizontal
        ? { class: chCx('stack-chart__grid', t === 0 ? 'stack-chart__zero' : null), x1: p, x2: p, y1: plot.y0, y2: plot.y1 }
        : { class: chCx('stack-chart__grid', t === 0 ? 'stack-chart__zero' : null), x1: plot.x0, x2: plot.x1, y1: p, y2: p }, [], `g${i}`) : null,
      chNode('text', horizontal
        ? { class: 'stack-chart__tick stack-chart__tick--middle', x: p, y: chR(plot.y1 + font + 4) }
        : { class: 'stack-chart__tick stack-chart__tick--end', x: chR(plot.x0 - 6), y: chR(p + 4) }, tickText[i], `t${i}`),
    ];
  })));
  // Category / time axis labels: placed left to right (top to bottom) at their real
  // positions, skipping any that would touch the previous one, so labels never overlap
  // even when time points are unevenly spaced. The first label is always placed.
  const labelRoom = horizontal ? left - yLabelSpace - 8 : Math.min(140, Math.max(24, plotW / 2));
  let lastEdge = -Infinity;
  parts.push(chNode('g', { class: 'stack-chart__axis stack-chart__axis--category', 'aria-hidden': 'true' }, xLabels.map((label, i) => {
    const p = chR(position(i));
    const text = chFit(label, labelRoom);
    if (horizontal) {
      if (p - font / 2 < lastEdge + 4) return null;
      lastEdge = p + font / 2;
      return chNode('text', { class: 'stack-chart__tick stack-chart__tick--end', x: chR(plot.x0 - 8), y: chR(p + 4) }, text, i);
    }
    // Edge labels are aligned to the chart's edge instead of spilling past it.
    const w = chTextWidth(text);
    let x0 = p - w / 2;
    let anchor = 'middle';
    let at = p;
    if (x0 < 0) { x0 = 0; anchor = 'start'; at = 0; } else if (x0 + w > width) { x0 = width - w; anchor = 'end'; at = width; }
    if (x0 < lastEdge + 8 || x0 < 0) return null;
    lastEdge = x0 + w;
    return chNode('text', { class: `stack-chart__tick stack-chart__tick--${anchor}`, x: chR(at), y: chR(plot.y1 + font + 6) }, text, i);
  })));
  if (props.yLabel) {
    const mid = chR((plot.y0 + plot.y1) / 2);
    parts.push(chNode('text', { class: 'stack-chart__axis-label stack-chart__tick--middle', x: chR(font), y: mid, transform: `rotate(-90 ${chR(font)} ${mid})` }, props.yLabel));
  }
  if (props.xLabel) parts.push(chNode('text', { class: 'stack-chart__axis-label stack-chart__tick--middle', x: chR((plot.x0 + plot.x1) / 2), y: chR(height - 4) }, props.xLabel));

  // Marks.
  const stacks = stacked ? chStack(rows, n) : null;
  const marks = [];
  if (bars) {
    const groupW = band * 0.72;
    const each = stacked ? groupW : groupW / Math.max(1, rows.length);
    rows.forEach((r, j) => {
      const rects = r.y.map((v, i) => {
        if (v === null) return null;
        const [lo, hi] = stacked ? stacks[j][i] : (v >= 0 ? [0, v] : [v, 0]);
        const a = value(lo);
        const b = value(hi);
        const start = position(i) - groupW / 2 + (stacked ? 0 : j * each);
        const size = Math.abs(b - a);
        if (size === 0) return null;
        return horizontal
          ? chNode('rect', { class: 'stack-chart__bar', x: chR(Math.min(a, b)), y: chR(start + 0.5), width: chR(size), height: chR(Math.max(1, each - 1)) }, [], i)
          : chNode('rect', { class: 'stack-chart__bar', x: chR(start + 0.5), y: chR(Math.min(a, b)), width: chR(Math.max(1, each - 1)), height: chR(size) }, [], i);
      });
      marks.push(chNode('g', { class: chCx('stack-chart__series', `stack-chart__s${r.palette}`, `stack-chart__d${r.dash}`), 'data-series': r.id }, rects, r.id));
    });
  } else {
    rows.forEach((r, j) => {
      const segments = [];
      let current = [];
      r.y.forEach((v, i) => {
        if (v === null) { if (current.length) segments.push(current); current = []; return; }
        const [lo, hi] = stacked ? stacks[j][i] : [0, v];
        current.push({ i, x: position(i), y: value(stacked ? (v >= 0 ? hi : lo) : v), base: value(stacked ? (v >= 0 ? lo : hi) : Math.max(scaleTicks.min, Math.min(0, scaleTicks.max))) });
      });
      if (current.length) segments.push(current);
      const children = [];
      const step = props.curve === 'step';
      segments.forEach((seg, s) => {
        // A step holds each value until the next x (a balance between postings), then moves.
        const path = step ? seg.flatMap((p, k) => (k ? [{ ...p, y: seg[k - 1].y, base: seg[k - 1].base }, p] : [p])) : seg;
        const line = path.map((p, k) => `${k ? 'L' : 'M'}${chR(p.x)} ${chR(p.y)}`).join(' ');
        if (kind === 'area' && seg.length > 1) {
          const back = [...path].reverse().map((p) => `L${chR(p.x)} ${chR(p.base)}`).join(' ');
          children.push(chNode('path', { class: 'stack-chart__area', d: `${line} ${back} Z` }, [], `a${s}`));
        }
        if (seg.length > 1) children.push(chNode('path', { class: 'stack-chart__line', d: line }, [], `l${s}`));
        // A point with no neighbour would be invisible as a line: always mark it.
        if (seg.length === 1 || props.points) {
          seg.forEach((p) => children.push(chNode('circle', { class: 'stack-chart__point', cx: chR(p.x), cy: chR(p.y), r: 3.5 }, [], `p${s}-${p.i}`)));
        }
      });
      marks.push(chNode('g', { class: chCx('stack-chart__series', `stack-chart__s${r.palette}`, `stack-chart__d${r.dash}`), 'data-series': r.id }, children, r.id));
    });
  }
  parts.push(chNode('g', { class: 'stack-chart__marks' }, marks));

  // One focusable target per category: hover or focus shows every series' value.
  const fmt = props.format;
  const focusable = n <= CH_MAX_FOCUSABLE;
  parts.push(chNode('g', { class: 'stack-chart__targets' }, normalized.keys.map((_, i) => {
    const centre = position(i);
    let lo;
    let hi;
    if (bars || xType === 'category') { lo = centre - band / 2; hi = centre + band / 2; } else {
      lo = i === 0 ? plot.x0 : (position(i - 1) + centre) / 2;
      hi = i === n - 1 ? plot.x1 : (centre + position(i + 1)) / 2;
    }
    const valueRows = rows.map((r) => ({ palette: r.palette, text: `${r.label}: ${formatChartValue(r.y[i], fmt)}` }));
    const label = `${xLabels[i]}: ${rows.map((r) => `${r.label} ${formatChartValue(r.y[i], fmt)}`).join(', ')}`;
    const area = horizontal
      ? { x: plot.x0, y: chR(lo), width: chR(plotW), height: chR(Math.max(1, hi - lo)) }
      : { x: chR(lo), y: plot.y0, width: chR(Math.max(1, hi - lo)), height: chR(plotH) };
    return chNode('g', { class: 'stack-chart__target', ...(focusable ? { tabindex: '0' } : {}), role: 'img', 'aria-label': label }, [
      chNode('rect', { class: 'stack-chart__target-area', ...area }),
      bars ? null : chNode('line', { class: 'stack-chart__cursor', x1: chR(centre), x2: chR(centre), y1: plot.y0, y2: plot.y1 }),
      chTooltip(horizontal ? Math.min(width - 20, plot.x0 + plotW / 2) : centre, horizontal ? chR(Math.min(lo + band, height - 16 * (rows.length + 2))) : plot.y0, width, xLabels[i], valueRows),
    ], i);
  })));

  const svg = chNode('svg', {
    class: 'stack-chart__svg', viewBox: `0 0 ${width} ${height}`, width, height,
    role: 'group', 'aria-label': `${props.title}. ${focusable ? 'Use Tab to read each value, or open the data table.' : 'Open the data table to read the values.'}`,
  }, parts);
  const table = chTable(props, [props.xLabel || (xType === 'time' ? 'Date' : 'Category'), ...rows.map((r) => r.label)],
    normalized.keys.map((_, i) => [xLabels[i], ...rows.map((r) => formatChartValue(r.y[i], fmt))]));
  return chFigure(kind, props, {
    state: 'ready',
    content: [showLegend ? chLegend(kind, legendRows, props) : null, chNode('div', { class: 'stack-chart__plot' }, svg), table],
  });
}

const kindName = (kind) => ({ line: 'LineChart', area: 'AreaChart', bar: 'BarChart' }[kind] || kind);

/// Lines over categories or time; `points` marks every value, `zeroBaseline: false` fits the axis to the data,
/// `curve: 'step'` holds each value until the next (balances).
function LineChart(props) { return cartesian('line', props || {}); }
/// Filled areas from zero; `stacked` stacks the series (positives up, negatives down); `curve: 'step'`.
function AreaChart(props) { return cartesian('area', props || {}); }
/// Grouped bars; `orientation: 'horizontal'`; `stacked` stacks the series.
function BarChart(props) { return cartesian('bar', props || {}); }
/// BarChart with `stacked: true`.
function StackedBarChart(props) { return cartesian('bar', { ...(props || {}), stacked: true }); }

// ---- Donut --------------------------------------------------------------------

const chArc = (cx, cy, r0, r1, a0, a1) => {
  const p = (r, a) => `${chR(cx + r * Math.sin(a))} ${chR(cy - r * Math.cos(a))}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${p(r1, a0)} A${chR(r1)} ${chR(r1)} 0 ${large} 1 ${p(r1, a1)} L${p(r0, a1)} A${chR(r0)} ${chR(r0)} 0 ${large} 0 ${p(r0, a0)} Z`;
};

/// Parts of a whole: one series whose x values name the slices. Negative values
/// cannot be parts of a whole: the chart says so instead of drawing them.
function DonutChart(props) {
  const p = props || {};
  const normalized = normalizeSeries('DonutChart', p.series, 'category');
  const visible = normalized.series.filter((r) => !r.hidden);
  if (visible.length > 1) chFail('DonutChart', 'shows exactly one series; hide the others or use another chart');
  const s = visible[0];
  const fmt = p.format;
  const slices = s ? normalized.keys.map((k, i) => ({ id: k, label: k, value: s.y[i], palette: (i % CHART_PALETTE_SIZE) + 1, dash: i % 4 })) : [];
  const negative = slices.filter((x) => x.value !== null && x.value < 0);
  const total = slices.reduce((t, x) => t + (x.value && x.value > 0 ? x.value : 0), 0);
  const pending = chState('donut', p, total > 0 && !negative.length);
  if (pending && !(negative.length && !p.error && !p.loading)) return chFigure('donut', p, pending);
  if (negative.length) {
    return chFigure('donut', p, {
      state: 'unsupported',
      content: chNode('div', { class: 'stack-chart__state' }, chNode('div', { class: 'stack-unavailable stack-unavailable--unsupported', role: 'note', 'data-capability-status': 'unsupported' }, [
        chNode('p', { class: 'stack-unavailable__title' }, 'This data cannot be shown as parts of a whole'),
        chNode('p', { class: 'stack-unavailable__reason' }, `Negative values: ${negative.map((x) => `${x.label} (${formatChartValue(x.value, fmt)})`).join(', ')}. Use a bar chart.`),
      ])),
    });
  }
  const { width, height } = chSize({ ...p, width: Math.min(Number(p.width) || 320, 360) }, { aspectRatio: 1, minHeight: 160, maxHeight: 360 });
  const size = Math.min(width, height);
  const cx = width / 2;
  const cy = height / 2;
  const r1 = size / 2 - 4;
  const r0 = r1 * (Number(p.innerRatio) > 0 && Number(p.innerRatio) < 0.95 ? Number(p.innerRatio) : 0.62);
  const share = (v) => (v && v > 0 ? v / total : 0);
  const pct = (v) => `${(share(v) * 100).toFixed(1)}%`;
  let angle = 0;
  const marks = [];
  slices.forEach((x, i) => {
    if (!(x.value > 0)) return;
    const sweep = share(x.value) * Math.PI * 2;
    // A full circle cannot be one arc: draw two halves.
    const d = sweep >= Math.PI * 2 - 1e-9
      ? `${chArc(cx, cy, r0, r1, 0, Math.PI)} ${chArc(cx, cy, r0, r1, Math.PI, Math.PI * 2)}`
      : chArc(cx, cy, r0, r1, angle, angle + sweep);
    const mid = angle + sweep / 2;
    marks.push(chNode('g', { class: chCx('stack-chart__slice', `stack-chart__s${x.palette}`), tabindex: '0', role: 'img', 'aria-label': `${x.label}: ${formatChartValue(x.value, fmt)}, ${pct(x.value)}`, 'data-slice': x.id }, [
      chNode('path', { class: 'stack-chart__arc', d }),
      chTooltip(chR(cx + (r1 * 0.6) * Math.sin(mid)), chR(Math.max(2, Math.min(height - 54, cy - r1 * 0.6 * Math.cos(mid) - 20))), width, x.label, [{ text: `${formatChartValue(x.value, fmt)} · ${pct(x.value)}` }]),
    ], i));
    angle += sweep;
  });
  const centreValue = chPresent(p.centerValue) ? String(p.centerValue) : formatChartValue(total, fmt);
  const centre = p.center === false ? null : chNode('g', { class: 'stack-chart__center', 'aria-hidden': 'true' }, [
    chNode('text', { class: 'stack-chart__center-value stack-chart__tick--middle', x: chR(cx), y: chR(cy + 2) }, chFit(centreValue, r0 * 1.8, 16)),
    chNode('text', { class: 'stack-chart__center-label stack-chart__tick--middle', x: chR(cx), y: chR(cy + 18) }, chFit(p.centerLabel || 'Total', r0 * 1.8)),
  ]);
  const svg = chNode('svg', { class: 'stack-chart__svg stack-chart__svg--donut', viewBox: `0 0 ${width} ${height}`, width, height, role: 'group', 'aria-label': `${p.title}. Use Tab to read each part, or open the data table.` }, [chNode('g', { class: 'stack-chart__marks' }, marks), centre]);
  const legendRows = slices.map((x) => ({ id: x.id, label: x.label, palette: x.palette, dash: x.dash, note: x.value === null ? '—' : `${formatChartValue(x.value, fmt)} · ${pct(x.value)}` }));
  const table = chTable(p, [p.xLabel || 'Category', s.label, p.shareLabel || 'Share'], slices.map((x) => [x.label, formatChartValue(x.value, fmt), x.value === null ? '—' : pct(x.value)]));
  return chFigure('donut', p, {
    state: 'ready',
    content: [chNode('div', { class: 'stack-chart__donut' }, [chNode('div', { class: 'stack-chart__plot stack-chart__plot--donut' }, svg), p.legend === false ? null : chLegend('donut', legendRows, { ...p, onToggleSeries: undefined })]), table],
  });
}

// ---- Sparkline ----------------------------------------------------------------

/// A compact trend: one series, no axes, no legend. An image with a text summary
/// (first, last, lowest and highest value); `endpoints` marks the first and last points.
function Sparkline(props) {
  const p = props || {};
  if (!chPresent(p.label)) chFail('Sparkline', 'needs a label (its accessible name)');
  const normalized = normalizeSeries('Sparkline', [{ id: 'spark', label: p.label, data: p.data || [] }], p.xType || 'category');
  const ys = normalized.series[0].y;
  const n = ys.length;
  const width = Math.max(24, Math.round(Number(p.width) || 120));
  const height = Math.max(12, Math.round(Number(p.height) || 32));
  const fmt = p.format;
  const present = ys.map((v, i) => ({ v, i })).filter((x) => x.v !== null);
  const cls = chCx('stack-sparkline', p.className);
  if (!present.length) {
    return chNode('span', { class: chCx(cls, 'stack-sparkline--empty'), role: 'img', 'aria-label': `${p.label}: no data`, ...chPassthrough(p.attrs) }, chNode('span', { class: 'stack-sparkline__empty', 'aria-hidden': 'true' }, '—'));
  }
  let min = Math.min(...present.map((x) => x.v));
  let max = Math.max(...present.map((x) => x.v));
  if (min === max) { min -= 1; max += 1; }
  const pad = 3;
  const x = (i) => (n === 1 ? width / 2 : pad + (i / (n - 1)) * (width - pad * 2));
  const y = chLinear(min, max, height - pad, pad);
  const segments = [];
  let cur = [];
  ys.forEach((v, i) => { if (v === null) { if (cur.length) segments.push(cur); cur = []; } else cur.push(i); });
  if (cur.length) segments.push(cur);
  const first = present[0];
  const last = present[present.length - 1];
  const summary = `${p.label}: ${formatChartValue(first.v, fmt)} to ${formatChartValue(last.v, fmt)}, low ${formatChartValue(Math.min(...present.map((q) => q.v)), fmt)}, high ${formatChartValue(Math.max(...present.map((q) => q.v)), fmt)}${present.length < n ? `, ${n - present.length} missing` : ''}`;
  const trend = last.v > first.v ? 'up' : last.v < first.v ? 'down' : 'flat';
  return chNode('span', { class: cls, 'data-trend': trend, ...chPassthrough(p.attrs) }, chNode('svg', {
    class: 'stack-sparkline__svg', viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': summary,
  }, [
    segments.map((seg, s) => (seg.length > 1
      ? chNode('path', { class: 'stack-sparkline__line', d: seg.map((i, k) => `${k ? 'L' : 'M'}${chR(x(i))} ${chR(y(ys[i]))}`).join(' ') }, [], s)
      : chNode('circle', { class: 'stack-sparkline__point', cx: chR(x(seg[0])), cy: chR(y(ys[seg[0]])), r: 1.75 }, [], s))),
    p.endpoints ? [first, last].map((q, k) => chNode('circle', { class: 'stack-sparkline__endpoint', cx: chR(x(q.i)), cy: chR(y(q.v)), r: 2.5 }, [], `e${k}`)) : null,
  ]));
}

const CHARTS = Object.freeze({ LineChart, AreaChart, BarChart, StackedBarChart, DonutChart, Sparkline });

// ---- dom.js
// Framework-free rendering of view trees into DOM nodes. Builds nodes with
// createElement / createTextNode / setAttribute only: it never parses markup
// or evaluates code. The built bundle must not even name those APIs, because
// Compute scans its served script for them literally (scripts/check-boundary.mjs).


/// Render a view tree (or string, number, array, Node) to a DOM Node.
const SVG_NS = 'http://www.w3.org/2000/svg';

function toDom(value, doc, ns) {
  const d = doc || document;
  if (value === null || value === undefined || value === false || value === true) return d.createDocumentFragment();
  if (typeof value === 'string' || typeof value === 'number') return d.createTextNode(String(value));
  if (Array.isArray(value)) {
    const fragment = d.createDocumentFragment();
    for (const item of value) fragment.appendChild(toDom(item, d, ns));
    return fragment;
  }
  if (isTree(value)) {
    // SVG (the brand mark) needs its namespace, inherited by its children.
    const space = value.t === 'svg' ? SVG_NS : ns;
    const element = space ? d.createElementNS(space, value.t) : d.createElement(value.t);
    for (const [key, attr] of Object.entries(value.a)) {
      if (attr === null || attr === undefined || attr === false) continue;
      element.setAttribute(key, attr === true ? '' : String(attr));
    }
    for (const [event, handler] of Object.entries(value.on || {})) element.addEventListener(event, handler);
    for (const child of value.c) element.appendChild(toDom(child, d, space));
    return element;
  }
  if (value && typeof value.nodeType === 'number') return value;
  throw new TypeError('toDom: unsupported child');
}

/// Moves focus to the shell's main landmark after a route change, so keyboard
/// and screen-reader users start at the new page's content.
function focusMain(id, doc) {
  const d = doc || document;
  // The same normalisation Shell applies to its mainId.
  const main = d.getElementById(String(id || 'stack-main').replace(/[^A-Za-z0-9_-]/g, '-'));
  if (main && typeof main.focus === 'function') main.focus({ preventScroll: true });
}

/// Each component as a function returning a DOM element, e.g.
///   StackUI.dom.StatusIndicator({ field: 'compute.health', value: 'healthy' })
const dom = Object.freeze(Object.fromEntries(
  Object.entries({ ...COMPONENTS, ...CHARTS }).map(([name, component]) => [name, (props, doc) => toDom(component(props || {}), doc)]),
));

/// The width a chart should be laid out at: its plot area's width if it has been
/// drawn, else the container's.
function chartWidth(container) {
  const plot = container.querySelector && container.querySelector('.stack-chart__plot');
  const width = (plot && plot.clientWidth) || container.clientWidth || 0;
  return width > 0 ? Math.round(width) : undefined;
}

/// Draws a chart into `container` at the container's width and redraws it when
/// that width changes (ResizeObserver), so labels stay legible at every size.
///   const chart = StackUI.mountChart(el, 'LineChart', { title, series });
///   chart.update(nextProps); chart.destroy();
/// `chart` is a CHARTS name or a chart function. A `width` prop fixes the width.
function mountChart(container, chart, props, doc) {
  const render = typeof chart === 'function' ? chart : CHARTS[chart];
  if (!render) throw new TypeError(`mountChart: unknown chart ${String(chart)}`);
  const d = doc || container.ownerDocument || document;
  let current = props || {};
  let laidOut;
  const draw = () => {
    laidOut = current.width || chartWidth(container);
    container.replaceChildren(toDom(render(laidOut ? { ...current, width: laidOut } : current), d));
  };
  draw();
  const View = d.defaultView && d.defaultView.ResizeObserver;
  const observer = View ? new View(() => {
    if (current.width) return;
    const next = chartWidth(container);
    if (next && next !== laidOut) draw();
  }) : null;
  if (observer) observer.observe(container);
  return {
    update(next) { current = next || {}; draw(); },
    destroy() { if (observer) observer.disconnect(); container.replaceChildren(); },
  };
}

// ---- Dialogs (PR4) -----------------------------------------------------------

/// Opens a rendered <dialog> as a modal and returns a function that closes it.
/// On close the dialog is removed and focus returns to whatever had it before
/// (normally the button that asked), as the dialog pattern requires.
function openDialog(dialog, doc) {
  const d = doc || dialog.ownerDocument || document;
  const returnTo = d.activeElement;
  if (!dialog.isConnected) d.body.appendChild(dialog);
  dialog.showModal();
  let closed = false;
  return function close() {
    if (closed) return;
    closed = true;
    if (dialog.open) dialog.close();
    dialog.remove();
    if (returnTo && returnTo.isConnected && typeof returnTo.focus === 'function') returnTo.focus();
  };
}

const failureOf = (error) => ({
  message: error && error.message ? error.message : String(error),
  ...(error && error.code ? { code: String(error.code) } : {}),
  ...(error && error.requestId ? { requestId: String(error.requestId) } : {}),
});

/// Asks for confirmation with ConfirmAction and resolves `true` once the
/// action is done, or `false` if the person cancels. With `action` (an async
/// function) the dialog stays open while it runs, shows it as busy, and shows
/// its error in place if it fails, so the person can retry or cancel; the
/// dialog closes only after the product reports success.
function confirmAction(props, doc) {
  const d = doc || document;
  let typed = '';
  let state = { busy: false, error: null };
  return new Promise((resolve) => {
    let dialog;
    let close;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      close();
      resolve(result);
    };
    const render = () => toDom(ConfirmAction({
      ...props,
      ...state,
      typed,
      onTypedChange: (value) => {
        typed = value;
        // This helper owns the DOM it built, so it updates the one attribute
        // that depends on the typed text rather than rebuilding the dialog.
        const confirm = dialog.querySelector('[data-dialog-confirm]');
        confirm.disabled = value !== props.requireText || state.busy;
      },
      onCancel: () => { if (!state.busy) finish(false); },
      // Confirm is handled by delegation below: the button's disabled state
      // changes as text is typed, without rebuilding it.
      onConfirm: undefined,
    }), d);
    const confirm = async () => {
      if (!props.action) { finish(true); return; }
      update({ busy: true, error: null });
      try {
        await props.action();
        finish(true);
      } catch (error) {
        update({ busy: false, error: failureOf(error) });
      }
    };
    const update = (next) => {
      state = next;
      const fresh = render();
      dialog.replaceChildren(...fresh.childNodes);
      for (const attr of Array.from(fresh.attributes)) dialog.setAttribute(attr.name, attr.value);
      const target = dialog.querySelector(state.error ? '[data-dialog-confirm]' : '[data-dialog-cancel]');
      if (target && !target.disabled) target.focus();
    };
    dialog = render();
    dialog.addEventListener('click', (event) => {
      const button = event.target.closest('[data-dialog-confirm]');
      if (button && !button.disabled && !state.busy) confirm();
    });
    // The browser may close a modal itself (a repeated Esc). While the action
    // runs the dialog is shown again; otherwise that is a cancel.
    dialog.addEventListener('close', () => {
      if (done) return;
      if (state.busy) dialog.showModal();
      else finish(false);
    });
    close = openDialog(dialog, d);
    const first = dialog.querySelector(filled(props.requireText) ? 'input' : '[data-dialog-cancel]');
    if (first) first.focus();
  });
}

// Named apart from view.js's helpers: the classic build shares one scope.
const filled = (value) => value !== null && value !== undefined && value !== '';

/// A dialog holding a short form of labelled fields (the replacement for
/// `prompt()`). Resolves with the submitted values once `action(values)`
/// succeeds, or `null` if the person cancels. While `action` runs the submit
/// button is busy; its error is shown in the dialog.
function formDialog(props, doc) {
  const d = doc || document;
  const id = String(props.id || 'stack-form-dialog').replace(/[^A-Za-z0-9_-]/g, '-');
  return new Promise((resolve) => {
    let close;
    let busy = false;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      close();
      resolve(result);
    };
    const dialog = toDom(Dialog({
      id,
      title: props.title,
      description: props.description,
      className: 'stack-form-dialog',
      onClose: () => { if (!busy) finish(null); },
    }), d);
    const body = d.createElement('div');
    body.className = 'stack-dialog__body';
    const errorSlot = d.createElement('div');
    const renderForm = () => toDom(Form({
      id: `${id}-form`,
      submitLabel: props.submitLabel || 'Save',
      busy,
      actions: Button({ label: props.cancelLabel || 'Cancel', variant: 'ghost', disabled: busy, onClick: () => { if (!busy) finish(null); }, attrs: { 'data-dialog-cancel': 'true' } }),
      children: (props.fields || []).map((fieldProps, index) => (fieldProps.options
        ? Select({ id: `${id}-field-${index}`, ...fieldProps })
        : TextField({ id: `${id}-field-${index}`, ...fieldProps }))),
      onSubmit: async (event) => {
        const values = Object.fromEntries(new FormData(event.target));
        if (!props.action) { finish(values); return; }
        busy = true;
        setBusy(event.target, true);
        errorSlot.replaceChildren();
        try {
          await props.action(values);
          finish(values);
        } catch (error) {
          busy = false;
          setBusy(event.target, false);
          errorSlot.replaceChildren(toDom(ErrorPanel({ title: 'Not saved', ...failureOf(error) }), d));
          event.target.querySelector('button[type="submit"]').focus();
        }
      },
    }), d);
    // Busy state without rebuilding the form, so typed values stay put.
    const setBusy = (form, value) => {
      for (const control of form.querySelectorAll('input, select, textarea, button')) control.disabled = value;
      const submit = form.querySelector('button[type="submit"]');
      if (value) submit.setAttribute('aria-busy', 'true'); else submit.removeAttribute('aria-busy');
    };
    body.append(errorSlot, renderForm());
    dialog.querySelector('.stack-dialog__surface').appendChild(body);
    dialog.addEventListener('close', () => {
      if (done) return;
      if (busy) dialog.showModal();
      else finish(null);
    });
    close = openDialog(dialog, d);
    const first = dialog.querySelector('input, select, textarea');
    if (first) first.focus();
  });
}

// ---- theme.js
// The theme preference (docs/product-shell.md §2): `system`, `light` or `dark`,
// stored per product origin. This is the only state the design system keeps,
// and the only module allowed to touch storage. Every access is wrapped: a
// private window, blocked site data or a throwing accessor leaves the page on
// the system theme, never broken.

const THEME_STORAGE_KEY = 'stack-ui.theme';
const THEME_PREFERENCES = Object.freeze(['system', 'light', 'dark']);

const storageOf = (scope) => {
  try {
    return scope && scope.localStorage ? scope.localStorage : null;
  } catch {
    return null;
  }
};

/// The stored preference, or `system` when there is none or it cannot be read.
function readThemePreference(scope) {
  const storage = storageOf(scope || globalThis);
  if (!storage) return 'system';
  try {
    const value = storage.getItem(THEME_STORAGE_KEY);
    return THEME_PREFERENCES.includes(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

/// Remembers a preference. Returns whether it was stored.
function storeThemePreference(preference, scope) {
  const storage = storageOf(scope || globalThis);
  if (!storage || !THEME_PREFERENCES.includes(preference)) return false;
  try {
    if (preference === 'system') storage.removeItem(THEME_STORAGE_KEY);
    else storage.setItem(THEME_STORAGE_KEY, preference);
    return true;
  } catch {
    return false;
  }
}

/// Applies a preference to the document: `light` or `dark` set
/// `data-stack-theme`; `system` removes it and follows the operating system.
function applyThemePreference(preference, root) {
  const element = root || (typeof document !== 'undefined' ? document.documentElement : null);
  if (!element) return;
  if (preference === 'light' || preference === 'dark') element.setAttribute('data-stack-theme', preference);
  else element.removeAttribute('data-stack-theme');
}

/// Reads, applies and returns the stored preference: call once at start-up,
/// before the first render, so the page never flashes the other theme.
function initThemePreference(scope, root) {
  const preference = readThemePreference(scope);
  applyThemePreference(preference, root);
  return preference;
}

/// Stores and applies a preference chosen in the shell's theme control.
function setThemePreference(preference, scope, root) {
  const value = THEME_PREFERENCES.includes(preference) ? preference : 'system';
  storeThemePreference(value, scope);
  applyThemePreference(value, root);
  return value;
}

/// The same start-up step as initThemePreference, as script text for the
/// <head> of a page rendered ahead of time (a static or server-rendered
/// site), so the stored theme applies before the first paint. It reads only
/// THEME_STORAGE_KEY, sets only data-stack-theme, and fails closed to the
/// system theme.
const THEME_INIT_SCRIPT = `(function(){try{var v=window.localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(v==="light"||v==="dark")document.documentElement.setAttribute("data-stack-theme",v);}catch(e){}})();`;

global.StackUI = Object.freeze({ version: "0.9.0", TONES, GLYPHS, OUTCOMES, OUTCOME_LABELS, VERIFICATION_STATES, FRESHNESS_STATES, CAPABILITY_STATES, humanize, fields, valuesOf, resolve, verification, verificationOf, freshnessOf, capability, PORTFOLIO, portfolioProduct, isTree, formatTime, StatusIndicator, VerificationBadge, FreshnessLabel, Unavailable, Loading, EmptyState, ErrorPanel, MetadataList, ResourceIdentity, PageHeader, Button, Breadcrumbs, tabsKeydown, Tabs, TabPanel, DataTable, FilterBar, Pagination, THEME_OPTIONS, Shell, TextField, Select, Form, Dialog, ConfirmAction, EvidenceSummary, Alert, Checkbox, FieldGroup, ActivityTimeline, BrandMark, ThemeSwitch, SiteHeader, SiteFooter, COMPONENTS, CHART_PALETTE_SIZE, formatChartValue, normalizeSeries, niceTicks, LineChart, AreaChart, BarChart, StackedBarChart, DonutChart, Sparkline, CHARTS, toDom, focusMain, dom, chartWidth, mountChart, openDialog, confirmAction, formDialog, THEME_STORAGE_KEY, THEME_PREFERENCES, readThemePreference, storeThemePreference, applyThemePreference, initThemePreference, setThemePreference, THEME_INIT_SCRIPT });
})(typeof window !== 'undefined' ? window : globalThis);
