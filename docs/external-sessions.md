# External Sessions and Context Projection

An External Session lets a Human or Agent continuously access another person's AI without
joining the Owner's native agent session or inheriting its private memory.

## Security baseline

Each session binds:

- Owner Principal and Owner Agent
- caller Principal, Agent, and paired Gateway, or an explicit guest capability
- one purpose and lease
- one immutable Context Grant
- allowed operations
- optional Group policy and membership epochs

Every paired-gateway operation is Ed25519-signed and bound to the session ID and request
payload. JAMA validates the caller, lease, session state, grant, Group epoch, and revocation
state on every turn. `a2aContextId` is only a protocol mapping and is never an authority
boundary.

For a Group-bound session, the caller must remain an active member whose role grants both
the `context` operation and `context:read` scope. Any policy or membership epoch change makes
the existing session stale and fail closed.

## Context Collections

The Owner explicitly registers collections and items. File collections accept only explicit
files under a configured real path, reject symlink targets and root escape, allow text and
source formats, and enforce a 1 MB item limit. JAMA does not scan disks or native private
agent sessions.

Projection uses local SQLite FTS5. A grant restricts collection IDs, sensitivity ceiling,
summary or exact mode, maximum items, maximum tokens, purpose, and expiration. The default is
eight summary-first items and 6,000 estimated tokens.

Projected blocks carry immutable Context Item IDs, authority, sensitivity, and source
digests. Audit records retain digests and references by default, not disclosed plaintext.

## Isolation and thread memory

External input is stored only as an `external-claim` in External Thread Memory. It is never
automatically promoted to Project Context or Owner Context.

Questions, clarifications, and tasks share the thread. Each task has a caller-generated,
immutable task ID; duplicate IDs are rejected. A completed task appends an immutable Artifact
event binding its result digest to that task ID.

Context-rich execution requires an adapter that declares isolated sessions and controlled
native-memory writes. ACP uses a runtime keyed by `externalSessionId`, always starts a new
session, and attempts `session/resume` after restart. If resume is unavailable, JAMA creates a
new isolated ACP session and reconstructs it from the persistent External Thread plus a fresh
Context Projection. This is recorded as degraded rehydration.

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
references the original External claim or evidence; it never changes the authority of the
source record or writes a native agent memory.

## Guest invitations

Guest endpoints are disabled unless `JAMAI_ENABLE_GUEST_INVITES=true`. A link contains a
256-bit token in its URL fragment. The database stores only its SHA-256 hash. Tokens expire
after 15 minutes and can be redeemed once. The resulting cookie is HttpOnly and SameSite
Strict, and receives `Secure` when the configured public URL uses HTTPS.

An invitation binds the Owner Agent, purpose, collections, sensitivity, operations, maximum
lease, and whether redemption is pre-authorized or requires Owner consent. Guests are marked
`guest-capability`; the capability does not assert a real-world identity.

Use guest access only on a LAN or behind a TLS reverse proxy.
