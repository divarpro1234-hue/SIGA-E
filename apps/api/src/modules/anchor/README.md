# Soroban Anchor Gateway

`SorobanTestnetAnchorGateway` normalizes Testnet identity, transaction lookup
and the `AlertRegistry.get_alert(BytesN<32>)` read to the existing
`SorobanAnchorGateway` contract. The SDK-backed
`StellarSdkSorobanRpcClient` uses the installed Stellar SDK 17.3.0 and accepts
only the explicitly trusted Testnet RPC endpoint, network passphrase and
deployment. Its `getAlert` invokes the Rust `get_alert` method by simulating a
contract-call transaction; it does not substitute a raw ledger-entry lookup.
The SDK XDR representation of `Option<BytesN<32>>` is decoded strictly:
`scvVoid` means `None`, while `scvBytes` must contain exactly 32 bytes.

`buildRegisterAlertInvocation` constructs the SDK operation for
`register_alert(BytesN<32>, BytesN<32>)`. The repository also contains a
concrete admin submitter and an interactive Stellar CLI signer; neither is
started by API bootstrap. Creating an RPC server is lazy; no RPC call occurs
during module import or client construction. Calling a gateway operation
backed by this client can perform Testnet read/simulation RPC, so such calls
remain outside unit tests unless a mock server is injected.

Gateway construction requires `enabled: true`; submission separately requires
`submissionEnabled: true` and an injected submitter whose public address matches
the configured deployment admin. No submitter or RPC connection is wired into
API startup. `NOT_FOUND` with no contract entry is kept `unknown` for a prior transaction hash:
the current contracts provide no persisted observation window that would make
a single not-found response safe for resubmission.
A matching `get_alert` read without transaction `SUCCESS` is represented only as
`matching_read`; the worker records it as uncertain and cannot publish from it.
Publication requires the queried transaction to be `SUCCESS` and the contract
readback to match the persisted JWS hash.

`createReadOnlyTestnetGateway({ deployment, endpointUrl, timeoutMs })` is the
explicit read-only entry point for the approved Testnet deployment. It rejects
database rows that disagree with the public identifiers in
`trusted-testnet-deployment.ts`, normalizes only the exact RPC URL with or
without its final slash, and supplies neither a signer nor a submitter.
`submit` always raises `SOROBAN_SUBMISSION_DISABLED`. Each reconciliation
checks the network passphrase and fetches the contract WASM through SDK
17.3.0's `getContractWasmByContractId`, then hashes the returned bytes with
SHA-256 before any `get_alert` simulation. A failure or mismatch is uncertain.
The worker also compares the active deployment against the independent public
constants before using a gateway. Its database id, generation and config
version remain database metadata: this step has no independently approved
values for them.

The SDK RPC server applies `timeoutMs` to each HTTP request and
`maxRedirects = 0` to its HTTP client. NETWORK and WASM each have their own
gateway deadline. `get_alert` has a deadline of `2 * timeoutMs`, because the
SDK performs two sequential bounded RPCs (load the source account, then
simulate the contract call). A timeout remains uncertain and can never mean
that a record is absent or confirmed. The client propagates its abort signal
through the SDK HTTP client's cancellation token; with SDK 17.3.0's bounded
Fetch adapter, this rejects the SDK request but does not abort its underlying
Fetch. The per-request HTTP timeout does abort that Fetch, and late results
cannot satisfy an already timed-out gateway operation. These transport details
must be rechecked on SDK upgrades. The WASM lookup and `get_alert` simulation
are separate RPC operations, so this step cannot prove they observed one
atomic ledger snapshot. Live Testnet identity and archived-state behavior
remain unverified in this offline step.

The manual Testnet runner opts into a separate 20-second HTTP and gateway
deadline for each WASM read; its NETWORK, account, simulation, signing and
send limits remain unchanged. It shares a single retry budget across its
initial preflight, submission preflight and preparation: at most one additional
WASM read in total, and only after a sanitized RPC timeout. A differing or
invalid WASM response, other RPC error, and any exhausted timeout remain
fail-closed. Per-attempt WASM diagnostics contain only phase, elapsed
milliseconds and a safe code.
The runner's initial read preflight, submission preflight and preparation
each perform their own trust checks; their reads are intentionally not reused
as substitutes for a later failed check. The fixed sequence bounds the
pre-simulation read budget to at most 230 seconds: 80 seconds for each of the
two gateway preflights and 50 seconds for submitter preparation, plus the
single 20-second retry. The 20-second WASM setting is not applied to
`sendTransaction`; transaction submission is never automatically retried.

`StellarSdkSorobanAdminSubmitter` implements the existing submitter interface
with an injected SDK-compatible RPC transport and an optional
`SorobanTransactionSigner`. Construction has no network or secret access.
Submission is disabled unless `submissionEnabled: true` is passed explicitly.
The signer receives prepared XDR and returns signed XDR; the submitter checks
the unchanged transaction signature base and verifies the admin public-key
signature before a single `sendTransaction` call. It checks the pinned network,
contract, administrator and WASM bytes, simulation result, one invocation,
fees and resource bounds. For `admin.require_auth()` with the pinned admin as
transaction source, it accepts exactly one `SOURCE_ACCOUNT` authorization whose
root invocation is the exact `register_alert` contract call and has no
sub-invocations. The transaction-envelope signature then covers that
source-account authorization. `ADDRESS`, `ADDRESS_V2`, and
`ADDRESS_WITH_DELEGATES` credentials require separate Soroban authorization
signatures and are rejected; duplicates, additional entries, altered roots and
any authorization changed by transaction assembly are also rejected. No
signer or transport is wired into API startup.

An RPC `PENDING` result is only a submission receipt. A send timeout or missing
response is `SEND_RESULT_UNCERTAIN`; no automatic resend occurs. The local
deadline cannot cancel an injected transport request already in flight.
Signer timeouts are `SIGNER_TIMEOUT` before any send; RPC preflight timeouts
are `RPC_TIMEOUT`. Simulation failures and definitive RPC rejection remain
distinct from uncertain send results.
Live authorization and fee behavior still require a separate approved Testnet
exercise before production wiring.

`StellarCliSecureStoreSigner` is an isolated implementation of
`SorobanTransactionSigner`. It accepts only the approved absolute CLI path,
Secure Store alias and Testnet identity. It requires `enabled: true` and a
fresh per-transaction `StellarSigningAuthorization` returned by the submitter's
injected `authorizeSigning` callback. No callback is configured by default.
The adapter passes prepared XDR only through stdin to `stellar tx sign` and
checks the returned envelope with the submitter's shared operation, fee and
public-key signature validation. The Node runner uses `spawn` with `shell:
false`, bounds stdout/stderr and kills the child on timeout or cancellation.
It does not call RPC, send or publish. It is not connected to API bootstrap or
the HTTP server. The separate `scripts/anchor-worker-once.ts` entry point
composes it with `PrismaAnchorWorker` for one explicitly approved operator
run; it never starts a background worker. It accepts only the explicit
`SIGAE_M5_ANCHOR_OPERATOR_URL` profile, validates the effective database,
runtime role and marker before querying deployments, and rejects
`DATABASE_URL`/`DIRECT_URL` instead of loading the project `.env`.

The M3 issue transaction persists the immutable compact JWS, `jwsHash`,
`messageKey`, and `anchor_jobs` row atomically. `PrismaAnchorWorker` reloads the
job with its alert, recomputes both identifiers, verifies the persisted JWS
against the trusted public key, and checks the active deployment against
`TRUSTED_TESTNET` before RPC. The operator runner requires
`--execute-testnet-anchor-once`, a non-CI interactive terminal, an initial
exact challenge, a second exact challenge for the prepared transaction hash,
and the signer's own transaction-hash challenge. The operator must also match
the configured local OS username. The runner is restricted to the exact
`127.0.0.1:55432/sigae_m5_anchor_operator` destination, runtime role and
database marker, and processes at most one job per invocation without polling.
It rejects `DATABASE_URL`/`DIRECT_URL`, the project `.env`, Neon and historical
test databases before querying jobs.

The general submitter ceiling remains 2,000 stroops. Only this explicitly
invoked interactive Testnet runner opts into the separate fee scope, defaults
to 40,000 stroops, and accepts `--max-testnet-fee-stroops <100..3000000>`.
Simulation total and assembled XDR fee are both checked against that selected
budget and displayed before the exact-XDR approval. The Secure Store signer
receives the same ceiling and retains its own transaction-hash challenge.
Other submitter consumers keep their 2,000-stroop ceiling. Mainnet is not a
valid deployment for this fee scope. A successful RPC submission is persisted
as `SUBMITTED`; a later worker run must observe transaction `SUCCESS` and a
matching trusted `get_alert` read before the worker can persist `PUBLISHED`.
Uncertain send results are not retried automatically.

### Reconciliación única de una transacción ya enviada

`scripts/reconcile-submitted-testnet-once.ts` es un modo separado, de solo
lectura en Soroban, limitado al job
`d7f5e3f6-4e58-4f20-b8ca-0e84fb792b8e`, la alerta
`1f84954a-ad6f-48d8-b280-fb531e6bf101` de severidad `Severe` y el hash de
transacción
`21c7bd0b60608f4cea0056ea54755e1258da27d3f141a0c42a3f26641b22865d`. No llama
al worker ni importa el submitter, el firmador Stellar CLI o un método
`sendTransaction`. Su interfaz RPC solo expone consultas de red, WASM,
`getTransaction` y `get_alert`. Para publicar exige simultáneamente el estado
`SUCCESS`, un ledger positivo, el deployment confiable y la coincidencia
exacta de `messageKey`/`jwsHash`; cualquier error, `NOT_FOUND`, discrepancia o
lease perdido detiene la ejecución sin retransmitir.

Desde la raíz del monorepo, la única invocación admitida es:

```powershell
pnpm --filter @siga-e/api exec tsx scripts/reconcile-submitted-testnet-once.ts --reconcile-submitted-testnet-once d7f5e3f6-4e58-4f20-b8ca-0e84fb792b8e
```

Requiere el operador OS autorizado, TTY interactiva no-CI, confirmación exacta
y el perfil local `SIGAE_M5_ANCHOR_OPERATOR_URL`; no carga `.env`, Neon ni otra
base. Antes del RPC lee y valida job, alerta, firma, hashes y deployment. En
PostgreSQL reclama ese job en una transacción serializable, incrementa su
contador, fija el lease y añade auditoría. En éxito, una segunda transacción
serializable establece `anchor_jobs.state=CONFIRMED`, conserva el hash
esperado, guarda `confirmed_ledger`, limpia el lease, establece
`alerts.lifecycle_state=PUBLISHED`, `anchor_status=CONFIRMED` y `published_at`,
y añade el evento de auditoría. Error RPC/`NOT_FOUND` limpia solo el lease,
registra el código saneado y conserva `SUBMITTED`; una huella distinta deja
`CONFLICT` y no publica. Las escrituras críticas y la auditoría son atómicas.
La implementación y sus pruebas son offline; esta guía no autoriza ejecutar
la reconciliación real.

## PostgreSQL operator laboratory

The separate `scripts/anchor-operator-lab.ts` tool has three modes:
`preflight` and `verify <alert_id> <public-key-thumbprint>` are read-only;
`initialize --accept-lab-write` is a one-alert M3 write flow and requires the
named OS operator, a non-CI interactive TTY, an exact random confirmation,
and active AUTHOR/APPROVER MFA sessions. It creates the JWS through
`PrismaDraftAlertService`, stores only the generated public JWK, and keeps the
ephemeral ES256 private key in memory. It creates one outbox job and never
calls the Soroban gateway. The verification command checks the supplied
thumbprint as an independent lab trust pin, recomputes payload/JWS/message
hashes, checks approval and job relations, and requires the alert to remain
`SIGNED_PENDING_ANCHOR`/`PENDING` with `published_at` null.

Use only a newly created `sigae_m5_anchor_operator` database on
`127.0.0.1:55432`. Create a non-superuser owner/migrator role
`sigae_m5_anchor_migrator` and a separate runtime role
`sigae_m5_anchor_operator`; the runtime role must not own the database, create
schemas, create roles/databases, or inherit memberships. Mark the database
with comment `SIGAE_M5_ANCHOR_OPERATOR_V1`. If that database already exists,
stop; none of the setup commands reuses or resets it.

In pgAdmin's Query Tool connected to the local PostgreSQL maintenance database,
first run these read-only existence checks. If either query returns any row,
stop and do not alter or reuse the existing object:

```sql
SELECT datname FROM pg_database WHERE datname = 'sigae_m5_anchor_operator';
SELECT rolname FROM pg_roles
WHERE rolname IN ('sigae_m5_anchor_migrator', 'sigae_m5_anchor_operator');
```

Only when all three names are absent, create both roles through pgAdmin with
`LOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`,
`NOREPLICATION`, and `NOBYPASSRLS`. Set separate passwords using each role's
Properties > Definition UI; never put passwords in SQL, command history,
documentation, or logs. Then create the database in pgAdmin with owner
`sigae_m5_anchor_migrator`, template `template0`, and UTF8 encoding. With the
maintenance connection, set the marker and database access:

```sql
COMMENT ON DATABASE sigae_m5_anchor_operator IS 'SIGAE_M5_ANCHOR_OPERATOR_V1';
REVOKE ALL ON DATABASE sigae_m5_anchor_operator FROM PUBLIC;
GRANT CONNECT ON DATABASE sigae_m5_anchor_operator
  TO sigae_m5_anchor_migrator, sigae_m5_anchor_operator;
```

Reconnect pgAdmin to the new database and run:

```sql
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

Do not run the creation statements for any existing database or role.

After creating the empty database, run
`scripts/run-anchor-operator-migrations.ps1` from an interactive PowerShell.
It asks for the exact migration acknowledgement and migrator password without
printing either; its preflight rejects any non-empty schema, and Prisma is
configured only from the validated migrator URL. The postflight checks the
three checked-in migrations and the resulting table set. Do not use
`DATABASE_URL`, `.env`, Neon or the runtime role for migration.

The migration ledger is intentionally private to the migrator. The authorized
migration flow checks `_prisma_migrations` and reports
`ANCHOR_OPERATOR_MIGRATIONS_VERIFIED` only after the migration postflight
confirms all three completed migrations and the complete schema. Do not grant
the runtime role access to `_prisma_migrations`.

To check migrator authentication and the empty-database preconditions without
applying migrations, run
`scripts/run-anchor-operator-migrations.ps1 -PreflightOnly`. This mode asks for
a separate read-only acknowledgement, uses a distinct environment marker, and
does not invoke Prisma. The runtime `preflight` independently checks PostgreSQL
identity, the 14 expected application tables, and lab readiness (roles, alert
and job state, public keys, and trusted deployment); it does not inspect or
claim verification of migration history. Failures report a phase and an
allowlisted error code; raw process output, connection strings, and credentials
are not printed.

After migrations, grant the runtime role only the required schema/table
privileges for M1 lab provisioning, M3 issuance, and AnchorWorker. In the new
database, run:

```sql
GRANT USAGE ON SCHEMA public TO sigae_m5_anchor_operator;
GRANT SELECT, INSERT, UPDATE ON TABLE
  public.users,
  public.identity_bootstrap,
  public.identity_invitations,
  public.identity_challenges,
  public.identity_rate_limits,
  public.sessions,
  public.public_keys,
  public.alerts,
  public.alert_references,
  public.approvals,
  public.anchor_deployments,
  public.anchor_jobs,
  public.audit_chain_state,
  public.audit_events
TO sigae_m5_anchor_operator;
```

Do not grant `CREATE`, `DELETE`, `TRUNCATE`, access to `_prisma_migrations`,
database ownership, or role membership. Then use the explicit
`SIGAE_M5_ANCHOR_OPERATOR_LAB` profile of `scripts/m1-lab.ts` to bootstrap
and activate local identities through the existing TOTP flow. It performs a
database identity check against the marker before opening Prisma writes.
From `apps/api`, the operator sequence is `bootstrap`, `confirm-first-admin`,
`create-author`, `confirm`, `create-approver`, `confirm`; each invocation is
interactive and uses the exact local M5 database profile. `confirm-first-admin`
accepts only the bootstrap identity and its one-time enrollment tokens; later
`confirm` calls require an active ADMIN's password and TOTP.

Before M3 initialization, record the actual deployment timestamp from
independent authoritative evidence. The schema requires `deployed_at`; the
tool requires that timestamp and compares it with any existing deployment row
rather than inventing or silently trusting a different value. `initialize` requires
`TOTP_ENCRYPTION_KEY` and the API's `SESSION_SECRET` in the protected process
environment, uses masked MFA prompts, logs out its temporary sessions, and
does not reuse a production signer. It refuses to initialize when any alert,
anchor job, or public key already exists, so an interrupted attempt must be
reviewed rather than rerun. A failure is not auto-rolled back across
the multiple existing M3 transactions; inspect with `preflight`/`verify` and
stop for review rather than rerunning or deleting rows.

Gateways tagged `OFFLINE_LAB` are rejected by default. They can be used only
with explicit opt-in while `NODE_ENV=test`; production CLI composition always
uses the concrete trusted Testnet gateway. Offline tests remain simulations,
not evidence of an actual Testnet transaction or PostgreSQL-backed publication.
The submitter also rechecks the outbox lease after signing and immediately
before `sendTransaction`; an expired lease cannot initiate a new send.

On Windows, killing the CLI process cannot guarantee termination of a child
process that Stellar CLI might start. A transport that ignores cancellation
may also continue running after the adapter's deadline; the adapter discards
that result. CLI 28.1.0 output syntax and Secure Store behavior have only been
simulated here and still need a separately authorized local validation.

`scripts/smoke-stellar-cli-offline-sign.ts` constructs an unsigned synthetic
Testnet envelope from a fixed fake sequence with time bounds `1..2` (Unix
seconds), then re-decodes its XDR and checks those bounds before any signing.
The default invocation performs no signing. Its explicit signing mode also
requires a live TTY challenge containing the full transaction hash; the CLI
flag alone cannot approve it. The script prints only the public validation
result and transaction hash. Stellar XDR does not encode the network
passphrase; the transaction hash and signature verification bind the envelope
to the pinned Testnet passphrase. No RPC or send capability is imported.

The offline M5 circuit integration test composes the actual gateway, submitter
and CLI signer with process and RPC doubles. Its synthetic signature bytes
exercise the XDR and signature-validation path with a mocked public-key
verification result; they do not prove that Testnet will accept a submitted
transaction or that a human approval policy is integrated into M5. The WASM
digest is also mocked because the deployed bytes are not fetched in this test.
`PENDING`, a transaction hash, and `SUCCESS` without matching contract storage
never confirm publication. `NOT_FOUND` after sending remains ambiguous.

`authorizeSigning` may mechanically return an approval object. For the real
`NodeStellarCliProcessRunner`, the signer now requires a second live TTY
challenge containing the full transaction hash before spawning CLI. A worker
or HTTP process without an interactive terminal cannot trigger that runner,
even if its callback returns `approved: true`. Process doubles bypass this
terminal boundary solely for isolated tests. This local prompt is an
operator-presence gate, not identity proof or a complete approval workflow.

`scripts/manual-soroban-testnet-anchor.ts` is a separate one-off Testnet
runner. Its default mode has no RPC or signing activity. Write mode requires
an explicit flag, a TTY, no `CI` environment marker, an operator declaration
that external authorization was obtained, and approval of the exact prepared
transaction hash. The real CLI signer still requires its own TTY challenge.
With the real Node process runner, the write function also requires this
script to be the direct process entrypoint; importing it from HTTP, bootstrap
or a worker fails before RPC. Injected process doubles remain available for
isolated tests.
The gateway's normal 10-second RPC deadline previously enclosed the entire
submitter call, including the operator's second prompt. That could produce
`SOROBAN_RPC_TIMEOUT` during `AUTHORIZATION` and leave a pending question.
Only this manual composition now selects the submitter's self-managed deadline
mode. Each RPC operation retains its own 10-second deadline; the exact-hash
human question starts a fresh, bounded 60-second timer when displayed. EOF,
SIGINT, cancellation, an empty answer and any non-exact phrase deny approval.
The submitter rejects a missing, mismatched or expired authorization before
calling the signer. The real CLI signer still asks its separate live challenge,
bounded to 60 seconds, followed by its separately bounded CLI process. The
manual submitter does not wrap that whole interactive signer call in the
10-second RPC deadline; non-manual submitters retain their original deadline.
Only the pinned manual Testnet runner now builds synthetic transactions with
180-second timebounds. The prior 30 seconds could expire during its two
separately bounded human challenges (up to 60 seconds each) and the bounded
signing process. Non-manual configurations keep their prior timebounds. The
manual fee ceiling defaults to 40,000 stroops; only
`--execute-testnet-write` accepts `--max-testnet-fee-stroops <100..3000000>`.
The opt-in ceiling is capped at 3,000,000 stroops (0.30 test XLM), and still
requires the pinned Testnet network, contract and administrator. Read-only
diagnosis retains its 40,000-stroop default, and general consumers retain
their 2,000-stroop ceiling.
The signer
verifies one Ed25519 signature from the pinned admin over the prepared hash and
Testnet passphrase; the same parsed signed envelope is handed to the RPC SDK,
which serializes it with `toXdr()`. A fresh check after hash approval and before
asking the signer, and another immediately before the send call, require at
least 20 seconds until `maxTime`. Expiry and a smaller margin have distinct
codes and never rebuild, re-sign or retry the old envelope. The longer window
also leaves a signed transaction valid for longer if its XDR escapes; access
to signed XDR therefore remains restricted, and sequence and contract checks
still apply. This does not prove
that network inclusion fees or account sequence remain valid after simulation;
both can change before a ledger accepts the transaction.
Before submitting, the runner reads the pinned deployment/WASM and requires a
conclusive absence for a fresh synthetic `message_key`. It shows the final
assembled transaction's source, contract, method, arguments, fee and time
bounds. It makes one `gateway.submit` call and never publishes an alert.

For `sendTransaction`, `PENDING` with the exact transaction hash is only a
submission receipt. `ERROR` with that hash is classified `RPC_REJECTED`; the
SDK-parsed `errorResult` is reduced to XDR transaction, operation and host
function variant names, fee charged, latest ledger metadata and diagnostic
event count. Raw error XDR and diagnostic event contents are never printed.
`DUPLICATE`, `TRY_AGAIN_LATER`, exceptions and mismatched hashes remain
uncertain. The old runner output discarded the `errorResult` entirely, so its
historical `RPC_REJECTED` cannot be attributed to a specific XDR code from
that output. A later `getTransaction` result of `NOT_FOUND` does not prove
non-submission; read-only reconciliation also checks `get_alert` for the same
message key and requires transaction `SUCCESS` plus matching contract readback
before reporting confirmation.

The runner calls `--reconcile-readonly <tx_hash> <message_key> <jws_hash>` to
inspect an uncertain result later without signing or resubmitting. It reports
confirmation only for gateway evidence that combines transaction `SUCCESS`
with a matching `get_alert` read. `PENDING`, `NOT_FOUND`, timeout and a hash
alone do not confirm. The transaction hash is printed before signing and
after any receipt; a hard process kill can still prevent a final report.
The application can bound its own send calls to one, but cannot prove that an
RPC timeout cancelled transmission or that the network accepted no copy.
TTY and an operator declaration cannot identify the human or prove an
external authorization grant. CI detection relies on available environment
markers; a pseudo-terminal can imitate an interactive session. Local doubles
do not establish real fee behavior, Stellar acceptance or live contract state.

The manual runner now prints its fresh public synthetic `message_key` and
`jws_hash` before any RPC read. Failures expose a sanitized phase, stable
classification and whether `sendTransaction` was called; the original RPC
payload and signed XDR are never printed. A pre-send failure is `BLOCKED`,
while a timeout after the send call remains `SEND_UNCERTAIN`. A readback
failure after a pending receipt is `RECONCILIATION_UNCERTAIN`. The prior
incident cannot be reconstructed from this later change because its generated
identifiers were not persisted or printed.

`--diagnose-readonly` is explicit and creates only a read-only gateway plus
the shared preparation/simulation function. Its RPC capability exposes
`getNetwork`, `getContractWasmByContractId`, `getAccount` and
`simulateTransaction`; it has no signer, authorization callback, gateway
`submit` call or `sendTransaction` method. A prepared hash in this mode is
labelled unsigned and unsent. This mode is not an observation of the prior
incident, since it uses a fresh synthetic key and current account state.

Fee policy uses stroops throughout. The general ceiling in the existing
non-manual submitter consumers and local fixtures remains 2,000 stroops.
The manual runner uses 40,000 stroops by default; only the separately gated
`--execute-testnet-write` mode can opt into an explicit budget up to 3,000,000
stroops. `--diagnose-readonly` always retains the 40,000-stroop default. No
environment variable or RPC response can raise either budget. The shared
submitter accepts the larger manual scope only when the pinned Testnet network,
contract and administrator match. The WASM check still applies. No AnchorWorker
submitter is currently composed in the API.
The configured inclusion fee is 100 stroops for its single operation, and the
expected total is `100 + BigInt(minResourceFee)`. A total above
the ceiling blocks before assembly. After SDK 17.3.0 assembles the transaction,
its `transaction.fee` must equal that expected total exactly and remain within
the selected ceiling. The diagnostic reports base fee, simulated resource fee,
calculated total, assembled XDR fee and budget before exact-XDR approval. No
budget option bypasses external authorization, exact-XDR approval or the
signer's interactive hash challenge. The SDK adds the `transactionData.resourceFee` to the raw fee, so
a discrepancy between that resource fee and `minResourceFee` blocks before
signing. The diagnostic reports only decimal stroop values and the rejecting
rule; an absent assembled XDR has no assembled fee to report. The independent
execution limits are 1,000,000 instructions, 100,000 disk read bytes and
100,000 write bytes. No live fee amount is inferred from local fixtures.
