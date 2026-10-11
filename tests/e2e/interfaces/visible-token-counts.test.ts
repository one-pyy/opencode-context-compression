import assert from "node:assert/strict";
import test from "node:test";
import { createHistoryReplayReaderFromSources, type CanonicalHostMessage } from "../../../src/history/history-replay-reader.js";
import { createCanonicalIdentityService } from "../../../src/identity/canonical-identity.js";
import { renderModelVisiblePartsText } from "../../../src/model-visible-transcript.js";
import { buildCompressionInspectDeleteEntries } from "../../../src/projection/compression-inspect.js";
import { createFlatPolicyEngine } from "../../../src/projection/policy-engine.js";
import { createProjectionBuilder } from "../../../src/projection/projection-builder.js";
import { createStaticReminderService } from "../../../src/projection/reminder-service.js";
import { computeCompressionStats } from "../../../src/runtime/compression-stats.js";
import { projectProjectionToEnvelopes } from "../../../src/runtime/messages-transform.js";
import { resolveSessionDatabasePath, resolvePluginStateDirectory } from "../../../src/runtime/sidecar-layout.js";
import { createResultGroupRepository } from "../../../src/state/result-group-repository.js";
import { bootstrapSessionSidecar, openSessionSidecarRepository } from "../../../src/state/sidecar-store.js";
import { createHermeticE2EFixture } from "../harness/fixture.js";

test("visible counts and delete listings include complete tool inputs, outputs and errors without metadata", async (t) => {
  const fixture = await createHermeticE2EFixture(t, { suite: "interfaces", caseName: "visible-tool-counts" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_request, init) => {
    const { text } = JSON.parse(String(init?.body)) as { text: string };
    return Response.json({ tokens: text.length });
  }) satisfies typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; fixture.networkDeny.restore(); });
  const databasePath = resolveSessionDatabasePath(resolvePluginStateDirectory(fixture.repoRoot), fixture.sessionID);
  await bootstrapSessionSidecar({ databasePath });
  const sidecar = await openSessionSidecarRepository({ databasePath });
  t.after(() => sidecar.close());
  const resultGroups = createResultGroupRepository(sidecar);
  const input = "input-head-" + "I".repeat(2000) + "-input-tail";
  const output = "output-head-" + "O".repeat(3000) + "-output-tail";
  const error = "error-head-" + "E".repeat(4000) + "-error-tail";
  const messages: CanonicalHostMessage[] = [
    { info: { id: "system", role: "system" }, parts: [{ type: "text", text: "System." }, { type: "tool", tool: "read", callID: "system-tool", state: { status: "completed", input, output } }] },
    { info: { id: "success", role: "assistant" }, parts: [{ type: "text", text: "Visible successful work." }, { type: "tool", tool: "bash", callID: "success-tool", state: { status: "completed", input, output, metadata: { diagnostics: "hidden-metadata".repeat(10000) } } }, { type: "text", text: "Trailing text." }] },
    { info: { id: "failure", role: "assistant" }, parts: [{ type: "tool", tool: "bash", callID: "failure-tool", state: { status: "error", input, error } }, { type: "reasoning", text: "excluded-reasoning" }, { type: "file", mime: "text/plain", url: "file:///excluded-attachment" }] },
  ];
  const builder = createProjectionBuilder({ historyReplayReader: createHistoryReplayReaderFromSources({ sessionId: fixture.sessionID, hostHistory: messages.map((message, i) => ({ sequence: i + 1, message })), toolHistory: [] }), policyEngine: createFlatPolicyEngine(), resultGroupRepository: resultGroups, canonicalIdentityService: createCanonicalIdentityService({ visibleIds: resultGroups }), reminderService: createStaticReminderService() });
  const projection = await builder.build({ sessionId: fixture.sessionID, replacementGateOpen: true });
  const envelopes = projectProjectionToEnvelopes(projection);
  for (const message of projection.messages) {
    const envelope = envelopes.find((item) => item.info.id === message.canonicalId);
    assert.ok(envelope);
    const text = renderModelVisiblePartsText(envelope.parts);
    assert.doesNotMatch(text, /hidden-metadata|excluded-reasoning|excluded-attachment/u);
    assert.equal(message.visibleTokenCount, text.length);
  }
  assert.ok(renderModelVisiblePartsText(envelopes[2]!.parts).includes(error));
  const listing = buildCompressionInspectDeleteEntries({ messages: projection.messages, policies: projection.state.messagePolicies, resultGroups: [], to: projection.state.messagePolicies.at(-1)!.visibleId });
  const listed = listing.filter((entry) => entry.kind === "compressible").reduce((total, entry) => total + entry.tokens, 0);
  assert.equal(listed, projection.messages.filter((message) => message.visibleKind === "compressible").reduce((total, message) => total + message.visibleTokenCount!, 0));
  const fallback = buildCompressionInspectDeleteEntries({ messages: projection.messages.map(({ visibleTokenCount: _count, ...message }) => message), policies: projection.state.messagePolicies, resultGroups: [], to: projection.state.messagePolicies.at(-1)!.visibleId });
  const approximated = fallback.filter((entry) => entry.kind === "compressible").reduce((total, entry) => total + entry.tokens, 0);
  assert.equal(approximated, envelopes.slice(1).reduce((total, envelope) => total + Math.ceil(renderModelVisiblePartsText(envelope.parts).length / 4), 0));
  const stats = await computeCompressionStats(projection, "t", async (text) => text.length);
  assert.equal(stats.protectedTokenCount, renderModelVisiblePartsText(envelopes[0]!.parts).length);
  assert.equal(stats.compressibleTokenCount, messages.slice(1).reduce((total, message) => total + renderModelVisiblePartsText(message.parts).length, 0));
});
