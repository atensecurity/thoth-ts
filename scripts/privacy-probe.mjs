// Runs only from a clean consumer of the packed npm artifact. All data is synthetic.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { format } from 'node:util';
import { instrument, ThothPolicyViolation } from '@atensec/thoth';
import { wrapOpenAITools } from '@atensec/thoth/openai';
import { wrapAnthropicTools } from '@atensec/thoth/anthropic';

const canaries = {
  args: 'SYNTHETIC_SECRET_sk_test_731q',
  phi: 'Synthetic Patient Juniper has Huntington disease',
  result: 'SYNTHETIC_RESULT_MRN_884217',
  error: 'SYNTHETIC_ERROR_patient_record_885',
  context: 'SYNTHETIC_CONTEXT_diagnosis_887',
  reason: 'SYNTHETIC_REASON_patient_888',
  receipt: 'SYNTHETIC_RECEIPT_patient_889',
  signal: 'SYNTHETIC_SIGNAL_patient_890',
  explanation: 'SYNTHETIC_EXPLANATION_patient_891',
};
const securitySignals = ['classification:phi', 'dlp_redactions:2', 'threat:prompt_injection',
  'threat:tool_output_poisoning:0.90', 'moses_risk:prompt_injection',
  'moses_risk_classification:improper_output_handling'];
const requests = [];
const logs = [];
const originalConsole = Object.fromEntries(['debug', 'warn', 'error'].map(k => [k, console[k]]));
for (const k of Object.keys(originalConsole)) console[k] = (...args) => logs.push(format(...args));
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  requests.push({ path: req.url, raw, body });
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/v1/events/batch') {
    // Rejected telemetry must not copy response text to logs.
    res.statusCode = 503;
    res.end(JSON.stringify({ error: canaries.error }));
  } else if (req.url === '/v1/enforce') {
    const decision = body.tool_args.mode || 'ALLOW';
    res.end(JSON.stringify({
      decision, reason: canaries.reason, violation_id: 'vio-synthetic-01',
      decision_reason_code: 'minimum_necessary_transform', action_classification: 'read',
      risk_score: 91, matched_rule_ids: ['rule-phi'], matched_control_ids: ['164.502(b)'],
      model_signals: [...securitySignals, canaries.signal, 'threat:' + canaries.phi],
      receipt: { decision_id: 'decision-synthetic-01', payload: canaries.receipt },
      policy_references: [canaries.phi], hold_token: 'hold-synthetic-01',
      modified_tool_args: { replacement: 'approved' },
    }));
  } else if (req.url === '/v1/explain') {
    res.end(JSON.stringify({ what_happened: canaries.explanation }));
  } else if (req.url.startsWith('/v1/enforce/hold/')) {
    res.end(JSON.stringify({ resolved: true, resolution: 'ALLOW' }));
  } else {
    res.statusCode = 404;
    res.end('{}');
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const config = {
  apiUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'synthetic-collector-key',
  agentId: 'synthetic-agent', tenantId: 'synthetic-tenant', userId: 'synthetic-user-id',
  approvedScope: ['read'], environment: 'dev',
  purpose: canaries.context, dataClassification: 'phi',
  taskContext: { notes: canaries.context, initiated_by: canaries.phi, task_id: canaries.phi, chain: [canaries.phi] },
  policyContext: { notes: canaries.context }, identityBinding: { notes: canaries.context },
};
try {
  for (const wrap of [
    (fns, cfg) => { const agent = { tools: Object.entries(fns).map(([name, run]) => ({ name, run })) }; instrument(agent, cfg); return Object.fromEntries(agent.tools.map(t => [t.name, t.run])); },
    wrapOpenAITools, wrapAnthropicTools,
  ]) {
    const calls = [];
    const thrown = new Error(canaries.error);
    const fns = wrap({ read: async input => { calls.push(input); if (input.throw) throw thrown; return canaries.result; } }, config);
    for (const mode of ['ALLOW', 'BLOCK', 'DEFER', 'MODIFY', 'STEP_UP']) {
      const input = { mode, token: canaries.args, clinical_note: canaries.phi };
      const before = calls.length;
      if (mode === 'BLOCK' || mode === 'DEFER') {
        await assert.rejects(fns.read(input), e => e instanceof ThothPolicyViolation && e.reason.includes(canaries.reason));
        assert.equal(calls.length, before);
      } else {
        assert.equal(await fns.read(input), canaries.result);
        assert.deepEqual(calls.at(-1), mode === 'MODIFY' ? { replacement: 'approved' } : input);
      }
    }
    await assert.rejects(fns.read({ throw: true, token: canaries.args }), e => e === thrown);
    const observed = wrap({ read: async input => { assert.equal(input.token, canaries.args); return canaries.result; } }, { ...config, enforcement: 'observe' });
    const count = requests.filter(r => r.path === '/v1/enforce').length;
    assert.equal(await observed.read({ token: canaries.args }), canaries.result);
    assert.equal(requests.filter(r => r.path === '/v1/enforce').length, count);
  }
  const stream = { tools: [{ name: 'read', async *run(input) { assert.equal(input.token, canaries.args); yield canaries.result; } }] };
  instrument(stream, config);
  const chunks = [];
  for await (const chunk of stream.tools[0].run({ token: canaries.args })) chunks.push(chunk);
  assert.deepEqual(chunks, [canaries.result]);

  const telemetry = requests.filter(r => r.path === '/v1/events/batch');
  const enforce = requests.filter(r => r.path === '/v1/enforce');
  assert.equal(enforce.length, 19);
  for (const { body } of enforce) {
    assert.equal(body.tool_args.token, canaries.args);
    assert.deepEqual(body.task_context, config.taskContext);
    assert.deepEqual(body.metadata.policy_context, config.policyContext);
    assert.deepEqual(body.identity_binding, config.identityBinding);
    assert.equal(body.purpose, config.purpose);
  }
  const explain = requests.filter(r => r.path === '/v1/explain');
  assert.equal(explain.length, 6);
  for (const { body } of explain) assert.equal(body.tool_args.token, canaries.args);
  const serialized = telemetry.map(r => r.raw).join('\n');
  const events = telemetry.flatMap(r => r.body.events);
  const uniqueEvents = [...new Map(events.map(event => [event.eventId, event])).values()];
  assert.deepEqual(Object.fromEntries(['LLM_INVOCATION', 'TOOL_CALL_PRE', 'TOOL_CALL_POST', 'TOOL_CALL_BLOCK'].map(type => [type, uniqueEvents.filter(e => e.eventType === type).length])), { LLM_INVOCATION: 7, TOOL_CALL_PRE: 22, TOOL_CALL_POST: 13, TOOL_CALL_BLOCK: 6 });
  for (const event of uniqueEvents) {
    assert.equal(events.filter(candidate => candidate.eventId === event.eventId).length, 3);
  }
  const leaks = Object.entries(canaries).filter(([, value]) => serialized.includes(value)).map(([name]) => name);
  const logLeaks = Object.entries(canaries).filter(([, value]) => logs.join('\n').includes(value)).map(([name]) => name);
  console.log(JSON.stringify({ telemetryRequests: telemetry.length, enforceRequests: enforce.length, explainRequests: explain.length, leakedCanaryFields: leaks, loggedCanaryFields: logLeaks }));
  assert.deepEqual(leaks, [], 'sensitive canaries must not leave in serialized telemetry');
  assert.deepEqual(logLeaks, [], 'SDK diagnostics must not log payloads or free-text reasons');
  for (const event of uniqueEvents.filter(e => e.eventType === 'TOOL_CALL_BLOCK')) {
    assert.equal(event.violationId, 'vio-synthetic-01');
    assert.ok(event.metadata.action_attestation_id);
    assert.ok(event.metadata.enforcement_trace_id);
    assert.equal(event.metadata.decision_reason_code, 'minimum_necessary_transform');
    assert.equal(event.metadata.risk_score, 91);
    assert.equal(event.metadata.decision_id, 'decision-synthetic-01');
    assert.deepEqual(event.metadata.matched_rule_ids, ['rule-phi']);
    assert.deepEqual(event.metadata.model_signals, securitySignals);
  }
  console.log('Installed package privacy, authorization, execution, and integration checks passed');
} finally {
  Object.assign(console, originalConsole);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
