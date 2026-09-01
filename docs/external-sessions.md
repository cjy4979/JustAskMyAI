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
regardless of thread length. Event sequence allocation is atomic. Periodic checkpoints retain
structured claims with authority, sensitivity, evidence references, source Event, and the
Authority Bundle digest under which they were observed. Claims are filtered again against the
current Context and Egress grants before restart rehydration.

The External Session ID is the stable External Thread ID. The active lease belongs to its
current Authority Bundle, not to the Thread itself. When an established lease expires, JAMA
moves the Session to `renewal_required`: messages and tasks fail closed, while Events,
Artifacts, Tasks, checkpoints, and opaque native-session generations remain intact. The
paired caller signs `session.renew` against the last Authority Bundle. A duplicate request is
idempotent. Owner approval re-evaluates or narrows the existing grants, appends a new
Authority Bundle version, and returns the same Thread to `active`. Initial consent requests
that expire without ever activating remain terminal `expired`; explicit `revoked` and
`closed` states cannot be renewed.

The default `managed` isolation policy accepts JAMA's Managed ACP Profile. It creates one
process and profile namespace per `externalSessionId` and redirects HOME, XDG, AppData,
temporary files, histories, Codex, Claude, Hermes, and other known Agent configuration paths.
The default Workspace is a new empty directory. Profile state is destroyed when the process
terminates, and restart uses audited degraded rehydration from JAMA's thread, checkpoint, and
fresh Context Projection.

Managed Profile assurance is `adapter-attested`: it prevents normal Agent memory
cross-contamination but is not an OS boundary against a malicious local process that ignores
the redirected paths. An explicit `owner-trusted` Workspace mode gives the Agent ordinary
access to the configured project and is therefore an Owner trust decision, not Context
Projection isolation.

The optional `strict` policy accepts only `enforced` isolation. The `acp-sandbox` adapter
launches one Docker container per External Session with an
independent HOME/XDG namespace, read-only root filesystem, empty isolated Workspace,
dedicated writable output, no capabilities, no network, and no Owner session mount. An
explicit local opt-in can mount the configured Workspace read-only when the entire root is
approved for that Session. It emits local enforcement evidence binding the configured image,
session memory namespace, mount manifest, and sandbox policy. This is evidence produced by
the local Gateway, not remote attestation of the image or host. Namespace state is destroyed
when the ACP process terminates, so this adapter never advertises native session resume. JAMA
reconstructs a new session from the persistent event thread, authority-filtered checkpoint,
and fresh Context Projection and records degraded rehydration.

Operation grants authorize protocol verbs such as message or task. Action grants separately
bound requested tool scopes, explicit denials, and resources. A task cannot expand the
session action grant. Tasks with action authority require a single-use Human approval bound
to the exact session, task ID, payload, scopes, denials, and resources.

The ACP permission hook evaluates both tool scope and actual `rawInput`/`locations`.
Action grants hold separate `allowedResources` and `deniedResources`; explicit denies always
win. Resource patterns support exact values, prefixes, `path:/root/**`, and URL prefixes.
Relative paths resolve against the adapter working directory, existing paths are checked via
their real path to block symlink escape, and generic Terminal/shell tools are unavailable in
External Sessions. When an Action Grant is resource-bound but ACP exposes no verifiable
resource, the call fails closed. The previous `per-tool` name meant runtime policy evaluation,
not a Human prompt; new grants call this mode `runtime-policy`.

## Provenance and egress

Structured answers contain claims, evidence references, source status, optional
model-reported confidence, and JAMA-computed evidence coverage. JAMA rejects unknown evidence
references and prevents a claim from receiving higher authority than its cited sources.
Unstructured output is accepted only when no Context was projected.

An Egress Grant is separate from the Context Grant. It limits source authority, sensitivity,
quote mode, excerpt size, evidence requirements, and categories that require Owner
confirmation. A valid Context Grant means the model may read an item; it does not imply the
caller may receive that item.

Non-structured output from a context-rich turn fails closed. Conservative Egress accounting
treats every projected item as potentially disclosed and scans the complete serialized answer,
including claim text, rather than trusting model-declared references. It creates a durable
Egress Challenge. The same
state transition is used when the model requests Owner confirmation or violates an Egress
Grant. Tasks move from `running` to `awaiting_owner_confirmation`; Owner release is bound to
the draft digest, Session, Task, Context references, Egress Grant, and Authority version.
Release validates the edited structured answer and records the original violation and explicit
Owner override. Challenge resolution, answer, Artifact, task terminal state, and status Event
commit in one transaction; rejection fails the task.

The Egress Guard also blocks known secret patterns and unauthorized references. Its strongest
guarantee remains projection: unauthorized Owner Context is never supplied to the model. It
does not claim complete semantic leak detection.

## Authority versions

Context, operation, action, Egress, and Group epoch authority are captured in an immutable,
gateway-signed Authority Bundle. Approval, renewal, extension, and Group reauthorization append a new
version linked by `previousAuthorityDigest`; old bundles remain queryable. Every post-open
External Session Envelope binds the complete current `authorityVersion` and `authorityDigest`,
so a message signed under an earlier Context, operation, action, Egress, or Group authority is
rejected. A Group epoch change pauses the Session until the Owner recomputes and reissues the
bundle.

## Writeback

A caller or Agent can only create a writeback proposal. The Owner accepts, rejects, or marks
it superseded through localhost. Acceptance creates a new `owner-confirmed` Context Item that
records proposer and confirming Owner and references the original External claim or evidence.
Its sensitivity cannot be lower than any cited source. It never changes source authority or
writes native agent memory. Evidence resolution follows the full local provenance closure
through old Events, their Context references, Artifacts, and referenced writebacks rather
than relying on the most recent thread window.

## Guest invitations

Guest redemption is disabled by default. The Owner can enable it from the localhost Owner
Hub; the setting is persisted locally. `JAMAI_ENABLE_GUEST_INVITES=true` remains a startup
default for automated deployments, but a persisted Owner choice takes precedence. The public
guest page may remain reachable while redemption is disabled so it can fail with a clear
message rather than a missing route. A link contains a 256-bit token in its URL fragment. The
database stores only its SHA-256 hash. Tokens expire after 15 minutes and can be redeemed
once. The resulting cookie is HttpOnly and SameSite Strict, and receives `Secure` when the
configured public URL uses HTTPS.
The server also stores a hashed session binding with its own expiry; cookie presence alone
does not authorize HTTP or SSE access.

The guest UI follows status events and also polls an authenticated session snapshot. This
allows a request-only invitation to unlock after Owner approval even when SSE is unavailable
or temporarily interrupted.

An invitation binds the Owner Agent, purpose, collections, sensitivity, operations, maximum
lease, and whether redemption is pre-authorized or requires Owner consent. Guests are marked
`guest-capability`; the capability does not assert a real-world identity.

Use guest access only on a LAN or behind a TLS reverse proxy.
