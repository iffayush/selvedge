import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveApiKey, extractJson, classifyError, modelChain, AIError, DEFAULT_MODEL, RECOMMENDED_MODELS } from '../lib/gemini.js';

test('API key comes from Settings first, then GEMINI_API_KEY, then GOOGLE_API_KEY', () => {
  assert.deepEqual(resolveApiKey({ geminiKey: 'a' }, { GEMINI_API_KEY: 'b' }), { key: 'a', source: 'settings' });
  assert.deepEqual(resolveApiKey({}, { GEMINI_API_KEY: 'b', GOOGLE_API_KEY: 'c' }), { key: 'b', source: 'GEMINI_API_KEY' });
  assert.deepEqual(resolveApiKey({}, { GOOGLE_API_KEY: 'c' }), { key: 'c', source: 'GOOGLE_API_KEY' });
  assert.equal(resolveApiKey({}, {}), null);
});

test('JSON is pulled out of plain, fenced, or wrapped replies', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('Result: {"a":3} done'), { a: 3 });
  assert.equal(extractJson('no json here'), undefined);
});

test('API failures become clear, actionable errors', () => {
  const code = (e) => classifyError(e).code;
  assert.equal(code({ status: 400, message: 'API key not valid. Please pass a valid API key.' }), 'auth');
  assert.equal(code({ status: 403, message: 'Permission denied' }), 'auth');
  assert.equal(code({ status: 404, message: 'models/x is not found' }), 'model');
  assert.equal(code({ status: 429, message: 'You exceeded your current quota' }), 'limit');
  assert.equal(code({ status: 503, message: 'The model is overloaded' }), 'overloaded');
  assert.equal(code(new TypeError('fetch failed')), 'network');
  assert.equal(code(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })), 'cancelled');
  assert.equal(code({ status: 400, message: 'Invalid JSON payload' }), 'bad_request');
  const own = new AIError('no_key', 'x');
  assert.equal(classifyError(own), own);
});

test('the chosen model is tried first, then the recommended fallbacks, without repeats', () => {
  assert.deepEqual(modelChain('gemini-x'), ['gemini-x', ...RECOMMENDED_MODELS]);
  assert.deepEqual(modelChain(RECOMMENDED_MODELS[1]), [RECOMMENDED_MODELS[1], RECOMMENDED_MODELS[0], ...RECOMMENDED_MODELS.slice(2)]);
  assert.equal(modelChain('')[0], DEFAULT_MODEL);
});
