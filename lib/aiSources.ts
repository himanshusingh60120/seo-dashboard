// lib/aiSources.ts
// Which GA4 session sources are AI assistants, and their display names. Shared by the GA4 routes and the dashboard.
/** GA4 regular expression (RE2), matched anywhere in sessionSource, case-insensitive. */
export const AI_SOURCE_PATTERN =
  "chatgpt|openai|perplexity|gemini\\.google|bard\\.google|copilot|claude\\.ai|anthropic|deepseek|grok|meta\\.ai|mistral|phind|you\\.com|poe\\.com";

const NAMES: [RegExp, string][] = [
  [/chatgpt|openai/i, "ChatGPT"],
  [/perplexity/i, "Perplexity"],
  [/gemini|bard/i, "Gemini"],
  [/copilot/i, "Microsoft Copilot"],
  [/claude|anthropic/i, "Claude"],
  [/deepseek/i, "DeepSeek"],
  [/grok/i, "Grok"],
  [/meta\.ai/i, "Meta AI"],
  [/mistral/i, "Mistral"],
  [/phind/i, "Phind"],
  [/you\.com/i, "You.com"],
  [/poe\.com/i, "Poe"],
];

/** "chatgpt.com" → "ChatGPT". Unknown sources keep their own name. */
export const assistantOf = (source: string) => NAMES.find(([re]) => re.test(source))?.[1] || source;

export const AI_ASSISTANT_LIST = "ChatGPT, Perplexity, Gemini, Microsoft Copilot, Claude, DeepSeek, Grok, Meta AI, Mistral, Phind, You.com and Poe";
