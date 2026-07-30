# External Sessions and Context Projection

An External Session lets a Human or Agent continuously access another person's AI without
joining the Owner's native agent session or inheriting its private memory.

## Security baseline

Each session binds:

- Owner Principal and Owner Agent
- caller Principal, Agent, and paired Gateway, or an explicit guest capability
- one purpose and lease
- one caller request and one separately issued Context Grant
- separate operation and action grants
- optional Group policy and membership epochs

The caller may request authority but cannot issue it. JAMA intersects the request with the
Owner's collection policy and records the resulting immutable issued grant. Owner approval
may only narrow the request. Generic status changes cannot bypass approval.

Every paired-gateway operation is Ed25519-signed and bound to the session ID and request
payload. JAMA validates the caller, lease, session state, issued grants, Group epoch, and
revocation state on every turn. `a2aContextId` is only a protocol mapping and is never an
authority boundary.

For a Group-bound session, the caller must remain an active member whose role grants both
the `context` operation and `context:read` scope. Any policy or membership epoch change makes
the existing session stale and fail closed.

## Context Collections

The Owner explicitly registers collections and items. A collection policy controls
visibility, permitted caller types and trust modes, exact-content access, sensitivity, item
and token limits, and whether paired callers may be auto-approved. Private collection names
and descriptions are not exposed by capability discovery; discoverable collections use a
public alias.

File collections accept only explicit
files under a configured real path, reject symlink targets and root escape, allow text and
source formats, and enforce a 1 MB item limit. JAMA does not scan disks or native private
agent sessions.

Projection uses local SQLite FTS5. The issued grant restricts collection IDs, sensitivity
ceiling, summary or exact mode, maximum items, maximum tokens, purpose, and expiration. The
default request is eight summary-first items and 6,000 estimated tokens, but policy may
reduce every dimension.

Projected blocks carry immutable Context Item IDs, authority, sensitivity, and source
digests. Audit records retain digests and references by default, not disclosed plaintext.

## Isolation and thread memory

External input is stored only in the session's event table. It is not inserted into a shared
Context Collection and is never automatically promoted to Project or Owner Context. Legacy
`external-claim` Context Items are readable only by the session recorded in their origin.

Questions, clarifications, and tasks share the thread. Each task has a caller-generated,
immutable task ID backed by a durable uniqueness constraint; duplicate IDs remain rejected
regardless of thread length. Event sequence allocation is atomic. Periodic checkpoints bind
the last included sequence, constraints, and context references for restart rehydration.

Context-rich execution requires `enforced` adapter isolation assurance. ACP uses a runtime
keyed by `externalSessionId`, always starts a new session, and attempts `session/resume` after
restart, but its environment declaration is only `operator-attested`. It therefore fails
closed by default unless the local operator explicitly opts into that residual risk. If
resume is unavailable, JAMA starts a new ACP session and reconstructs it from the persistent
event thread, checkpoint, and fresh Context Projection. This is recorded as degraded
rehydration.

Operation grants authorize protocol verbs such as message or task. Action grants separately
bound requested tool scopes, explicit denials, and resources. A task cannot expand the
session action grant. Tasks with action authority require a single-use Human approval bound
to the exact session, task ID, payload, scopes, denials, and resources.

## Provenance and egress

Structured answers contain claims, evidence references, source status, optional
model-reported confidence, and JAMA-computed evidence coverage. JAMA rejects unknown evidence
references and prevents a claim from receiving higher authority than its cited sources.
Unstructured output is downgraded to `agent-inference` with zero evidence coverage.

The Egress Guard blocks known secret patterns, unauthorized Context references, and
sensitivity violations for Owner escalation. Its strongest guarantee is projection:
unauthorized Owner Context is never supplied to the model. It is not a complete semantic
leak detector.

## Writeback

A caller or Agent can only create a writeback proposal. The Owner accepts, rejects, or marks
it superseded through localhost. Acceptance creates a new `owner-confirmed` Context Item that
records proposer and confirming Owner and references the original External claim or evidence.
Its sensitivity cannot be lower than any cited source. It never changes source authority or
writes native agent memory.

## Guest invitations

Guest endpoints are disabled unless `JAMAI_ENABLE_GUEST_INVITES=true`. A link contains a
256-bit token in its URL fragment. The database stores only its SHA-256 hash. Tokens expire
after 15 minutes and can be redeemed once. The resulting cookie is HttpOnly and SameSite
Strict, and receives `Secure` when the configured public URL uses HTTPS.
The server also stores a hashed session binding with its own expiry; cookie presence alone
does not authorize HTTP or SSE access.

An invitation binds the Owner Agent, purpose, collections, sensitivity, operations, maximum
lease, and whether redemption is pre-authorized or requires Owner consent. Guests are marked
`guest-capability`; the capability does not assert a real-world identity.

Use guest access only on a LAN or behind a TLS reverse proxy.
