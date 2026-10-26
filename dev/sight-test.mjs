/**
 * Her eyesight without a Harness: a fake `llm`/`attachments`/`agentDefaultModel`, a real screenshot.
 *
 *   node dev/sight-test.mjs
 *
 * The fake is shaped after the failure seen in the real Host: a prepared call refuses to dispatch a
 * config that no longer matches what `prepareCall` materialized. `describe()` therefore dispatches
 * through `llm.stream`; if it ever goes back to the prepared handle, this test fails the same way the
 * Host did — including the guard that made it fail in the first place.
 */
import { createSight } from '../lib/sight.js';

const said = [];
const brain = { say: (text) => said.push(`say: ${text}`), act: (word) => said.push(`act: ${word}`) };
const prefs = { get: () => ({ sight: true }) };

const services = {
  attachments: {
    async saveImage(input) {
      if (!(input.data instanceof Uint8Array)) throw new Error('saveImage wants bytes');
      if (input.mediaType !== 'image/png') throw new Error(`saveImage got ${input.mediaType}`);
      console.log('saveImage:', input.name, input.data.byteLength, 'bytes');
      return { attachmentId: 'test-image', mediaType: 'image/png', bytes: input.data.byteLength, width: 1280, height: 720 };
    },
  },
  agentDefaultModel: {
    currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
  },
  llm: {
    // what the real Host did to us: the prepared handle pins the config it materialized
    async prepareCall(config) {
      const resolved = { ...config, maxTokens: config.maxTokens ?? 400, temperature: config.temperature ?? 0.4, reasoningEffort: 'max' };
      return {
        config: resolved,
        inputModalities: ['text', 'image'],
        stream() {
          throw new Error('prepared LLM call config changed before adapter dispatch');
        },
      };
    },
    // the path `describe()` must take: prepare and dispatch in one step
    stream(options) {
      if (!options.messages?.[0]?.content?.some((part) => part.type === 'image')) {
        throw new Error('the request carried no image');
      }
      if (options.purpose !== 'session-title') console.log('note: purpose is', options.purpose);
      console.log('llm.stream:', options.provider, options.model, `${options.maxTokens} max tokens`);
      return (async function* chunks() {
        yield { type: 'text-delta', index: 0, text: '你开着 Harness，' };
        yield { type: 'text-delta', index: 0, text: '屏幕停在这只桌宠的设置页。' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  },
};

const ctx = { get: (name) => services[name] };

const sight = createSight({ ctx, prefs, brain, log: (line) => console.log(line) });
const result = await sight.look('test');
console.log('\nresult:', result);
console.log('bubbles:', said);
if (!result.ok) process.exit(1);
if (!said.some((line) => line.startsWith('say: ') && line.includes('Harness'))) {
  console.error('FAIL: she never said what she saw');
  process.exit(1);
}

// With a session to talk to, the picture goes *there* instead, as an image part on a user turn.
const prompts = [];
services.sessionController = {
  async prompt(request) {
    prompts.push(request);
    return { accepted: true };
  },
};
const fedSaid = [];
const fed = createSight({
  ctx,
  prefs,
  brain: { say: (text) => fedSaid.push(text), act: () => {} },
  log: (line) => console.log(line),
  targetSession: () => 'session-test-1',
});
const fedResult = await fed.look('test');
console.log('\nfeed result:', fedResult);
console.log('prompt parts:', prompts[0]?.content.map((part) => part.type + (part.type === 'image' ? `(${part.mediaType}, ${part.data.length} b64 chars)` : '')));
console.log('bubbles:', fedSaid);
if (!fedResult.ok || fedResult.session !== 'session-test-1') { console.error('FAIL: the picture did not reach the session'); process.exit(1); }
if (!prompts[0]?.content.some((part) => part.type === 'image' && part.data.length > 1000)) {
  console.error('FAIL: the prompt carried no image bytes'); process.exit(1);
}

// and the gate: with the setting off, nothing is captured at all
const closed = createSight({ ctx, prefs: { get: () => ({ sight: false }) }, brain, log: () => {} });
const denied = await closed.look('test');
console.log('with sight off:', denied);
if (denied.ok) { console.error('FAIL: looked while not allowed'); process.exit(1); }
console.log('\nok');
