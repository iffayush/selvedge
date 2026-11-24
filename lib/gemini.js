// Gemini API client: asks for JSON that matches a schema, then validates it with Zod.
import { GoogleGenAI } from '@google/genai';

// Checked against a free-tier key on 2026-11-23: these answer with valid JSON.
export const DEFAULT_MODEL = 'gemini-3.6-flash';
export const RECOMMENDED_MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'];
const TIMEOUT_MS = 3 * 60 * 1000;
// Errors where a different model may still work.
const TRY_NEXT_MODEL = new Set(['overloaded', 'model', 'limit', 'timeout']);

export class AIError extends Error {
  constructor(code, message, detail = '') {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/** Where the API key comes from: Settings first, then the environment. */
export function resolveApiKey(cfg = {}, env = process.env) {
  if (cfg.geminiKey) return { key: cfg.geminiKey, source: 'settings' };
  if (env.GEMINI_API_KEY) return { key: env.GEMINI_API_KEY, source: 'GEMINI_API_KEY' };
  if (env.GOOGLE_API_KEY) return { key: env.GOOGLE_API_KEY, source: 'GOOGLE_API_KEY' };
  return null;
}

/** Pull a JSON value out of a reply (whole text, a fenced block, or first {..last }). */
export function extractJson(text) {
  if (typeof text !== 'string') return undefined;
  const attempts = [text.trim()];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) attempts.push(fence[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) attempts.push(text.slice(first, last + 1));
  for (const a of attempts) {
    try {
      return JSON.parse(a);
    } catch {}
  }
  return undefined;
}

/** Turn an SDK or network failure into a message a person can act on. */
export function classifyError(err) {
  if (err instanceof AIError) return err;
  const status = Number(err?.status ?? err?.code ?? 0);
  const msg = String(err?.message || err || '');
  if (err?.name === 'AbortError' || /aborted/i.test(msg)) {
    return new AIError('cancelled', 'Cancelled.');
  }
  if (/api key not valid|api_key_invalid|invalid api key/i.test(msg) || status === 401 || status === 403) {
    return new AIError('auth', 'Gemini rejected the API key. Check it in Settings.', msg);
  }
  if (status === 404 || /not found|is not supported for generateContent/i.test(msg)) {
    return new AIError('model', "That Gemini model isn't available for your key. Pick another one in Settings.", msg);
  }
  if (status === 429 || /quota|rate limit|resource_exhausted/i.test(msg)) {
    return new AIError('limit', "You've hit Gemini's rate limit or daily free quota. Wait a minute and try again, or pick a Flash model in Settings.", msg);
  }
  if (status >= 500 || /overloaded|unavailable/i.test(msg)) {
    return new AIError('overloaded', 'Gemini is busy right now. Try again in a minute.', msg);
  }
  if (/fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|network/i.test(msg)) {
    return new AIError('network', "Couldn't reach Gemini. Check your internet connection.", msg);
  }
  if (status === 400) {
    return new AIError('bad_request', `Gemini couldn't process the request: ${msg.slice(0, 300)}`, msg);
  }
  return new AIError('ai_error', `Gemini returned an error: ${msg.slice(0, 300)}`, msg);
}

function client(apiKey) {
  if (!apiKey) {
    throw new AIError('no_key', 'No Gemini API key found. Add one in Settings (free at aistudio.google.com/apikey).');
  }
  return new GoogleGenAI({ apiKey });
}

function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** One generateContent call that must return JSON. */
export async function generateJson({ apiKey, model = DEFAULT_MODEL, systemPrompt, prompt, jsonSchema, signal, timeoutMs = TIMEOUT_MS }) {
  const ai = client(apiKey);
  const abortSignal = withTimeout(signal, timeoutMs);
  let resp;
  try {
    resp = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json',
        ...(jsonSchema ? { responseJsonSchema: jsonSchema } : {}),
        abortSignal,
      },
    });
  } catch (err) {
    if (abortSignal.aborted && !signal?.aborted) {
      throw new AIError('timeout', 'Gemini took longer than 3 minutes. Try again, or pick a faster model.');
    }
    throw classifyError(err);
  }
  const text = resp?.text;
  if (!text) {
    const block = resp?.promptFeedback?.blockReason || resp?.candidates?.[0]?.finishReason;
    throw new AIError('blocked', `Gemini returned no answer${block ? ` (${block})` : ''}. Try again or adjust the text.`);
  }
  return { data: extractJson(text), text, finishReason: resp?.candidates?.[0]?.finishReason };
}

/** The chosen model first, then the recommended ones as fallbacks. */
export function modelChain(model) {
  return [...new Set([model || DEFAULT_MODEL, ...RECOMMENDED_MODELS])];
}

/**
 * Ask for JSON matching a Zod schema. If a model is busy, unavailable or out of quota,
 * the next recommended model is tried. Resolves {data, model} with the model that answered.
 */
export async function askStructured({ model, ...opts }) {
  const chain = modelChain(model);
  let lastErr;
  for (const m of chain) {
    try {
      const data = await askStructuredOnce({ ...opts, model: m });
      return { data, model: m };
    } catch (err) {
      lastErr = err;
      if (!(err instanceof AIError) || !TRY_NEXT_MODEL.has(err.code) || opts.signal?.aborted) throw err;
    }
  }
  throw lastErr;
}

/** One model: ask, validate with Zod, and retry once with the validation errors. */
async function askStructuredOnce({ zodSchema, ...opts }) {
  let prompt = opts.prompt;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, text } = await generateJson({ ...opts, prompt });
    const parsed = zodSchema.safeParse(data);
    if (parsed.success) return parsed.data;
    if (attempt === 1) {
      throw new AIError(
        'bad_output',
        "Gemini's answer didn't have the expected shape. Please try again.",
        JSON.stringify(parsed.error.issues.slice(0, 5)) + '\n' + String(text).slice(0, 500),
      );
    }
    const issues = parsed.error.issues
      .slice(0, 8)
      .map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    prompt = `${opts.prompt}\n\nIMPORTANT: Your previous answer did not match the required JSON schema:\n${issues}\nReturn only JSON that matches the schema exactly.`;
  }
  throw new AIError('bad_output', 'Unexpected state.');
}

const NOT_TEXT_MODELS = /image|banana|tts|audio|embed|live|omni|veo|imagen|aqa|robotics|computer-use/i;

/** Text models this key can see, recommended ones first, for the Settings dropdown. */
export async function listModels(apiKey) {
  const ai = client(apiKey);
  const out = [];
  try {
    const pager = await ai.models.list({ config: { pageSize: 200 } });
    for await (const m of pager) {
      const id = String(m.name || '').replace(/^models\//, '');
      if (!/^gemini/i.test(id) || NOT_TEXT_MODELS.test(id) || NOT_TEXT_MODELS.test(m.displayName || '')) continue;
      if (!(m.supportedActions || []).includes('generateContent')) continue;
      out.push({ id, label: m.displayName || id, recommended: RECOMMENDED_MODELS.includes(id) });
    }
  } catch (err) {
    throw classifyError(err);
  }
  const rank = (m) => (m.recommended ? RECOMMENDED_MODELS.indexOf(m.id) : 100);
  out.sort((a, b) => rank(a) - rank(b));
  return out;
}
