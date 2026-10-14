// lib/llm.ts
// Server-only. GPT (OpenAI) writes text. Jev (TypeSafe AI) is a decision model: it only answers typed questions
// with probabilities, so it's used for cheap yes/no checks. API keys never reach the browser.
import type { AiUsage } from "./audit/catalog";

export type Usage = AiUsage;

export class LlmError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const emptyUsage = (): Usage => ({ gptIn: 0, gptOut: 0, jevIn: 0, gptCalls: 0, jevCalls: 0 });

export function llmConfig() {
  return {
    gpt: !!process.env.OPENAI_API_KEY,
    jev: !!process.env.JEV_API_KEY,
    gptModel: process.env.OPENAI_MODEL || "gpt-5-mini",
    jevModel: process.env.JEV_MODEL || "jev-latest",
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postJson(url: string, key: string, body: unknown, timeoutMs: number): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        cache: "no-store",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (attempt < 1 && !(e instanceof Error && e.name === "TimeoutError")) {
        await sleep(1000);
        continue;
      }
      throw new LlmError(0, e instanceof Error && e.name === "TimeoutError" ? `No answer within ${Math.round(timeoutMs / 1000)} s` : "Network error");
    }
    const text = await res.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: { message: text.slice(0, 200) } };
    }
    if (res.ok) return data;
    // 429 = rate limit, 529 = Jev overloaded, 5xx = transient
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      const after = Number(res.headers.get("retry-after"));
      await sleep(Math.min(5000, after > 0 ? after * 1000 : 1000 * 2 ** attempt));
      continue;
    }
    const err = data?.error;
    const msg = typeof err === "string" ? err : err?.message || JSON.stringify(data?.detail ?? data).slice(0, 300);
    throw new LlmError(res.status, msg || `HTTP ${res.status}`);
  }
}

function parseJsonLoose(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {}
    }
    throw new LlmError(0, "The model didn't return valid JSON");
  }
}

/** Chat completion that must return a JSON object. */
export async function gptJson<T = any>(system: string, user: string, usage: Usage, timeoutMs = 40_000): Promise<T> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new LlmError(0, "OPENAI_API_KEY isn't set");
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const body: Record<string, unknown> = {
    model: llmConfig().gptModel,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    response_format: { type: "json_object" },
  };
  // Optional, for reasoning models only (e.g. "low" makes gpt-5 models faster and cheaper).
  if (process.env.OPENAI_REASONING_EFFORT) body.reasoning_effort = process.env.OPENAI_REASONING_EFFORT;
  let data: any;
  try {
    data = await postJson(`${base}/chat/completions`, key, body, timeoutMs);
  } catch (e) {
    if (!(e instanceof LlmError && e.status === 400 && /response_format/i.test(e.message))) throw e;
    delete body.response_format;
    data = await postJson(`${base}/chat/completions`, key, body, timeoutMs);
  }
  usage.gptCalls++;
  usage.gptIn += Number(data?.usage?.prompt_tokens) || 0;
  usage.gptOut += Number(data?.usage?.completion_tokens) || 0;
  const msg = data?.choices?.[0]?.message;
  if (!msg?.content) throw new LlmError(0, msg?.refusal || "Empty answer from the model");
  return parseJsonLoose(String(msg.content)) as T;
}

/** Jev "noul" questions: returns the probability of "yes" for each question (NaN when missing). */
export async function jevYesNo(state: string, questions: Record<string, string>, usage: Usage, timeoutMs = 15_000): Promise<Record<string, number>> {
  const key = process.env.JEV_API_KEY;
  if (!key) throw new LlmError(0, "JEV_API_KEY isn't set");
  const base = (process.env.JEV_BASE_URL || "https://api.typesafe.ai").replace(/\/$/, "");
  const data = await postJson(
    `${base}/v1/systemone`,
    key,
    {
      state: state.slice(0, 24_000),
      model: llmConfig().jevModel,
      questions: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { type: "noul", instructions: q }])),
    },
    timeoutMs
  );
  usage.jevCalls++;
  usage.jevIn += Number(data?.usage?.input_tokens) || 0;
  const out: Record<string, number> = {};
  for (const k of Object.keys(questions)) out[k] = Number(data?.answers?.[k]?.noul);
  return out;
}
