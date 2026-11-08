# Default telemetry capture and compatibility

The SDK emits minimal telemetry to `POST /v1/events/batch`. It does not export
argument values, argument keys, result values, free-text block reasons, task or
delegation context, purpose text, explanations, policy-reference text, or complete
receipts. Unknown metadata is omitted. Event content is a fixed lifecycle label.
There is no raw-capture switch. This is field omission, not regex redaction.

Retained evidence: event/tenant/agent/session/user/tool/violation identifiers,
approved scope and tool history, timestamp, enforcement mode, trace and action
attestation IDs, receipt decision ID, decision/reason/classification codes,
pack/version/rule/control/regime IDs, duration, result type/size, risk score,
latency and timeout values. Model signals are limited to known action, threat/risk and
classification categories, numeric confidence/counts and availability/attestation
status. Unknown model signals are
omitted rather than assumed to be content-free. Metadata includes
`telemetry_capture: "minimal"`.

Identifiers, tool names, scope, policy codes and environment labels are still
exported and may appear in SDK logs. Applications and enforcers must use opaque,
non-sensitive identifiers/codes: do not put names, email addresses, patient IDs,
secrets or clinical text in these fields. This is not a de-identification guarantee.
Regex matching alone cannot guarantee PHI removal. Length/timing and activity
patterns also remain observable. Application logs and provider requests are
outside this boundary.

## Withholding values at the source (opt-in)

> Not in a published release yet: this ships in the next release of `@atensec/thoth`.

By default the SDK sends full tool arguments and task context to the authorization endpoints
(`/v1/enforce`, `/v1/explain`) so that value-based rules and outbound data checks can run. You can
opt in, per client, to withhold them with `dataHandlingToolArguments` (`hash`, `redact`, `drop`) and
`dataHandlingPrompts` (`hash`, `drop`), or `THOTH_DATA_HANDLING_TOOL_ARGUMENTS` and
`THOTH_DATA_HANDLING_PROMPTS`. Nothing changes when they are unset.

With a mode set, the SDK does not send tool-argument values to Thoth. It transforms them in your
process before the request is built and declares what it did in a `data_handling` field on the
request. Prompt-bearing text and long free text in the task context, identity binding and policy
context get the prompts mode; identifiers there are sent as given, and so are `sessionIntent`,
`purpose` and `dataClassification`, which you set.

Still sent to Thoth: tool names, decisions and their evidence, key names of tool arguments (except in
`drop` mode), session ids, user ids, agent and tenant ids, timing, the tool-call sequence, and the
identifiers and labels above. `hash` values are HMAC-SHA256 keyed with a salt that stays with your
client (`THOTH_DATA_HANDLING_SALT`, else random per process); Thoth does not hold it, and equal values
match only under the same salt. A low-entropy value can be confirmed by anyone who has the salt.

Local scan findings. So rules that need values can still be answered, a client that withholds tool
arguments also scans the raw arguments in its own process (heuristic patterns, `thoth-detectors.v1`)
and sends `client_findings`: counts and categories of credentials, emails, phone numbers,
SSN-shaped numbers and confidentiality phrases, whether a path looks sensitive, one destination
hostname, and recipient domains. It never sends values, paths, the local part of an address, display
names or message text. A hostname or a recipient domain can itself be sensitive to you; set
`THOTH_DATA_HANDLING_LOCAL_SCAN=off` to send no findings. Thoth cannot verify the scan: it relies on
it only if your workspace opted in and listed the scanner's ruleset hash. A workspace that requires
client findings holds every call from a client that withholds arguments and sends none.

Effect on decisions: rules and outbound data checks that need argument values cannot run on values
Thoth does not have. A call that such a rule would examine is held for review (`STEP_UP`, reason code
`args_withheld`) rather than decided blind, and with `drop` some checks fall back on tool-name
heuristics. This option limits what Thoth receives; it does not make any statement about what your
own tools, logs or other services do with the values.

## What still leaves the process

| Destination                   | Data                                                                                                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/events/batch`            | Minimal evidence described above; API key in Authorization and X-Api-Key headers                                                                                                                                                  |
| `/v1/enforce`                 | Original serialized arguments (unless withheld, see above), identity binding, policy context, task context, purpose, data classification, session intent, identity/scope/history and correlation fields; API key in Authorization |
| `/v1/explain` (BLOCK/STEP_UP) | Original serialized arguments (unless withheld, see above), identity/scope/history, decision evidence and correlation fields; API key in Authorization                                                                            |
| `/v1/enforce/hold/{token}`    | Hold token in URL; API key in Authorization                                                                                                                                                                                       |

Authorization/explanation requests can contain secrets and PHI. They continue to
use the configured trusted tenant API. Removing telemetry content does **not**
make all SDK traffic free of sensitive information. OBSERVE mode does not send
authorization requests. No authorization serialization, policy thresholds,
fail-open defaults or decision handling changed.

OpenAI and Anthropic helpers wrap tool execution via the same instrumentor. They
do not intercept provider HTTP calls, prompts, messages or responses. Tool
arguments and return values remain unchanged except existing authorized MODIFY
behavior. ThothPolicyViolation retains its detailed reason/explanation/receipt
for the caller. Ordinary tool errors retain their original identity. SDK diagnostics
omit response bodies, raw transport errors, free-text reasons and hold tokens.

## Compatibility

Consumers using raw telemetry arguments/context/reasons/receipts must migrate to
correlation IDs and structured decision evidence. Full receipts are not signed
or reissued by the projection; telemetry must not be treated as a full receipt.
No method signatures changed. Result capture remains type and size only.
Lifecycle behavior is unchanged: failed tools emit PRE but no successful POST;
streaming results are yielded unchanged. All event paths, including session
start and provider helpers, pass through the serialization boundary.

## Reproduction and validation

Run `npm test`, `npm run typecheck`, and `npm run test:package` with Node 22+.
The package test builds, packs and installs the tarball in a clean temporary npm
consumer, then uses native Node and a loopback HTTP collector. It needs cached
npm dependencies (or populate npm's cache first). No provider credentials or
external services are needed; only synthetic data is used.

On main `bb5d7af6f`, the probe observed 48 telemetry requests, 19 authorization
requests and 6 explanation requests. It failed with telemetry canaries from
arguments, PHI, context, reasons, receipts, model signals and explanations; SDK
logs also exposed the error-response and reason canaries. Results did not leak.
The same probe now requires all canaries absent from serialized telemetry and
SDK logs while requiring original authorization/explanation inputs and retained
evidence. It checks ALLOW, BLOCK, DEFER, MODIFY, STEP_UP, OBSERVE, thrown errors,
streaming tools and both provider wrappers. This is a live local HTTP test of the
installed artifact, not a deployed-service or external-provider validation.

## Advisory tool inventory

Instrumentation sends tool names, descriptions, and input-schema structure with tenant and agent IDs to your configured Thoth API. Schema `default`, `example`, `examples`, `const`, and `enum` values are removed recursively. Descriptions and other schema text may still contain sensitive information: avoid embedding secrets in tool metadata. Set `THOTH_TOOL_INVENTORY=off` to disable inventory collection without disabling runtime enforcement. Uploads run in the background and do not grant execution authority.
