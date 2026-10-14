// lib/audit/solve.ts
// Server-only. One issue group in → one checked fix out.
// 1) Jev cost gate: for medium/low issues, if the standard fix already covers the evidence, GPT is skipped.
// 2) GPT drafts a fix from the evidence (JSON only).
// 3) Code checks: no URLs or numbers that aren't in the data, no unsafe advice, a complete answer.
// 4) Jev judges grounded / addresses / safe / actionable (a second GPT pass reviews instead if there's no Jev key).
// 5) If anything fails, GPT revises once with the exact problems, then everything is re-checked.
//    Still failing → "needs human review" (shown clearly, never presented as verified).
import { CATALOG, type Check, type IssueGroup, type Solution } from "./catalog";
import { emptyUsage, gptJson, jevYesNo, llmConfig, type Usage } from "../llm";

type Draft = Pick<Solution, "summary" | "causes" | "steps" | "verify" | "examples">;

const PASS = 0.7;
const GATE_PASS = 0.85;
const BUDGET_MS = 55_000;
const DOC_HOSTS = ["developers.google.com", "support.google.com", "search.google.com", "schema.org"];
const BANNED: [RegExp, string][] = [
  [/disallow:\s*\/\s*(?:$|\n|["'`])/im, "suggests blocking the whole site in robots.txt"],
  [/noindex\s+(?:the\s+|your\s+)?(?:entire|whole)\s+(?:site|website)/i, "suggests noindexing the whole site"],
  [/(?:delete|remove)\s+all\s+(?:pages|urls|content)/i, "suggests deleting all pages"],
  [/\b(?:buy|purchase)\s+(?:back)?links?\b/i, "suggests buying links"],
  [/\bhidden text\b|\bcloak/i, "suggests deceptive tactics"],
];
const JUDGE: Record<"grounded" | "addresses" | "safe" | "actionable", [string, string]> = {
  grounded: ["Grounded in the data", "Every statement in ANSWER about this specific website (its URLs, counts, dates, status codes, settings) is supported by EVIDENCE or METRICS."],
  addresses: ["Addresses the issue", "The steps in ANSWER address the problem described in ISSUE."],
  safe: ["Safe advice", "ANSWER avoids advice that would block, noindex, delete or redirect pages that EVIDENCE does not show to be broken or unwanted."],
  actionable: ["Actionable", "Each step in ANSWER is a specific action that someone could carry out."],
};
const GATE = "The STANDARD FIX fully covers the situation shown in EVIDENCE; nothing in EVIDENCE calls for different or extra advice.";

const DRAFT_SYSTEM = `You are a senior technical SEO engineer. You write the fix for one group of issues found in a website's Google Search Console data.
Rules:
1. Use only facts in EVIDENCE and METRICS. Never invent URLs, numbers, dates, CMS or server names, or causes the data doesn't show.
2. Don't restate counts; the dashboard shows them. Quote a number only if it appears in EVIDENCE or METRICS.
3. If the evidence can't tell which cause applies, say exactly what to check to tell the causes apart.
4. Follow Google's documented guidance. Never suggest link buying, cloaking, hidden text, or blocking/noindexing pages that should rank.
5. Steps must be concrete actions an SEO or developer can carry out, in order.
Return JSON only, in this shape:
{"summary":"2-4 sentences","causes":["most likely first"],"steps":["3-8 ordered steps"],"verify":["1-4 ways to confirm the fix"],"examples":["up to 5 URLs copied exactly from EVIDENCE"]}`;

const REVIEW_SYSTEM = `You strictly check another model's ANSWER against the EVIDENCE for one SEO issue.
Return JSON only: {"grounded":true|false,"addresses":true|false,"safe":true|false,"actionable":true|false,"problems":["one short line per problem"]}
grounded: every claim about this specific site is supported by EVIDENCE or METRICS.
addresses: the steps fix the ISSUE.
safe: no advice that could remove valid pages from Google or break the site.
actionable: each step is a concrete action.`;

const cache = new Map<string, { at: number; sol: Solution }>();

const arr = (v: unknown, n: number) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean).slice(0, n) : []);
const shape = (x: any): Draft => ({
  summary: String(x?.summary ?? "").trim().slice(0, 1500),
  causes: arr(x?.causes, 6),
  steps: arr(x?.steps, 10),
  verify: arr(x?.verify, 5),
  examples: arr(x?.examples, 5),
});
const trimUrl = (u: string) => u.trim().replace(/[.,;:!?)\]]+$/, "");
const normU = (u: string) => trimUrl(u).replace(/\/$/, "").toLowerCase();
const nums = (s: string) =>
  (s.match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => n.replace(/,/g, "")).filter((n) => n.replace(".", "").length >= 2);

function codeChecks(d: Draft, g: IssueGroup) {
  const known = new Set(
    [...g.urls, ...g.evidence.flatMap((r) => Object.values(r)).filter((v): v is string => typeof v === "string" && /^https?:\/\//i.test(v))].map(normU)
  );
  const text = [d.summary, ...d.causes, ...d.steps, ...d.verify].join("\n");
  const foreign = (text.match(/https?:\/\/[^\s"'<>)\]]+/gi) || []).filter((u) => {
    if (known.has(normU(u))) return false;
    try {
      const h = new URL(trimUrl(u)).hostname.replace(/^www\./, "");
      return !DOC_HOSTS.some((dh) => h === dh || h.endsWith(`.${dh}`));
    } catch {
      return true;
    }
  });
  const allowed = new Set([
    ...nums(JSON.stringify(g.evidence)), ...nums(JSON.stringify(g.metrics)), ...nums(JSON.stringify(CATALOG[g.type])), String(g.count),
  ]);
  // HTTP status codes (100–599) are allowed in explanations.
  const stray = Array.from(
    new Set(nums([d.summary, ...d.causes].join(" ")).filter((n) => !allowed.has(n) && !(/^\d{3}$/.test(n) && +n >= 100 && +n <= 599)))
  );
  const unsafe = BANNED.filter(([re]) => re.test(text)).map(([, why]) => why);
  const complete = d.summary.length >= 20 && d.steps.length >= 2 && d.verify.length >= 1;
  const checks: Check[] = [
    { name: "Only URLs from the data", passed: !foreign.length, detail: foreign.length ? `Not in the data: ${foreign.slice(0, 3).join(", ")}` : "Every URL is from the data or Google's documentation" },
    { name: "Only numbers from the data", passed: !stray.length, detail: stray.length ? `Not in the data: ${stray.slice(0, 5).join(", ")}` : "Every figure in the summary and causes appears in the data" },
    { name: "No unsafe advice", passed: !unsafe.length, detail: unsafe.length ? unsafe.join("; ") : "No site-wide blocking, mass deletion or spam tactics" },
    { name: "Complete answer", passed: complete, detail: `${d.steps.length} steps, ${d.verify.length} verification checks` },
  ];
  return {
    checks,
    problems: checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`),
    cleaned: { ...d, examples: d.examples.filter((u) => known.has(normU(u))) },
  };
}

const stateText = (g: IssueGroup, d: Draft) =>
  `ISSUE: ${g.title}. ${CATALOG[g.type].what}\nEVIDENCE: ${JSON.stringify(g.evidence.slice(0, 15))}\nMETRICS: ${JSON.stringify(g.metrics)}\nANSWER: ${JSON.stringify(d)}`;

async function judge(g: IssueGroup, d: Draft, usage: Usage, useJev: boolean, msLeft: number): Promise<{ checks: Check[]; problems: string[] }> {
  if (useJev) {
    try {
      const p = await jevYesNo(stateText(g, d), Object.fromEntries(Object.entries(JUDGE).map(([k, [, q]]) => [k, q])), usage, Math.min(15_000, msLeft));
      const checks = Object.entries(JUDGE).map(([k, [label]]) => ({
        name: `Jev: ${label}`,
        passed: p[k] >= PASS,
        detail: Number.isFinite(p[k]) ? `${Math.round(p[k] * 100)}% yes` : "no answer",
      }));
      return { checks, problems: checks.filter((c) => !c.passed).map((c) => `${c.name} (${c.detail})`) };
    } catch {
      /* Jev unavailable: fall back to a GPT review */
    }
  }
  if (msLeft < 12_000) return { checks: [{ name: "Review", passed: false, detail: "Skipped: time limit" }], problems: ["review skipped"] };
  const r = await gptJson<Record<string, unknown>>(REVIEW_SYSTEM, stateText(g, d), usage, Math.min(30_000, msLeft));
  const checks = Object.entries(JUDGE).map(([k, [label]]) => ({ name: `GPT review: ${label}`, passed: r[k] === true, detail: r[k] === true ? "yes" : "no" }));
  return { checks, problems: [...checks.filter((c) => !c.passed).map((c) => c.name), ...arr(r.problems, 5)] };
}

export async function solveGroup(site: string, g: IssueGroup): Promise<Solution> {
  const hit = cache.get(g.fingerprint);
  if (hit && Date.now() - hit.at < 24 * 3_600_000) return hit.sol;
  const cfg = llmConfig();
  const usage = emptyUsage();
  const c = CATALOG[g.type];
  const started = Date.now();
  const left = () => BUDGET_MS - (Date.now() - started);
  const models = () => [usage.gptCalls ? cfg.gptModel : "", usage.jevCalls ? cfg.jevModel : ""].filter(Boolean);
  const done = (s: Omit<Solution, "usage" | "models" | "generatedAt">): Solution => {
    const sol: Solution = { ...s, usage, models: models(), generatedAt: new Date().toISOString() };
    if (sol.status !== "error") cache.set(g.fingerprint, { at: Date.now(), sol });
    return sol;
  };
  const standard = (checks: Check[]) =>
    done({ status: "standard", summary: c.what, causes: c.causes, steps: c.steps, verify: c.verify, examples: g.urls.slice(0, 5), checks });

  if (!cfg.gpt) return standard([{ name: "AI", passed: true, detail: "OPENAI_API_KEY isn't set, so this is the standard fix" }]);

  // Cost gate (Jev is cheap; GPT is skipped when the standard fix is enough).
  if (cfg.jev && (g.severity === "medium" || g.severity === "low")) {
    try {
      const p = await jevYesNo(
        `ISSUE: ${g.title}. ${c.what}\nEVIDENCE: ${JSON.stringify(g.evidence.slice(0, 15))}\nSTANDARD FIX: ${JSON.stringify({ causes: c.causes, steps: c.steps })}`,
        { standard: GATE },
        usage
      );
      if (p.standard >= GATE_PASS) {
        return standard([{ name: "Jev: standard fix is enough", passed: true, detail: `${Math.round(p.standard * 100)}% yes, so GPT wasn't needed` }]);
      }
    } catch {
      /* the gate is optional */
    }
  }

  const input = JSON.stringify({
    site,
    issue: { title: g.title, category: g.category, severity: g.severity, description: c.what, affected_count: g.count, source: g.source },
    standard_fix: { causes: c.causes, steps: c.steps, verify: c.verify },
    evidence: g.evidence.slice(0, 15),
    metrics: g.metrics,
  });

  let code = codeChecks(shape(await gptJson(DRAFT_SYSTEM, input, usage, Math.min(40_000, left()))), g);
  let review = await judge(g, code.cleaned, usage, cfg.jev, left());
  let status: Solution["status"] = "verified";

  if (code.problems.length || review.problems.length) {
    status = "needs_review";
    if (left() > 25_000) {
      const fix =
        `${input}\n\nYOUR PREVIOUS ANSWER:\n${JSON.stringify(code.cleaned)}\n\n` +
        `FIX THESE PROBLEMS AND RETURN THE CORRECTED JSON ONLY:\n- ${[...code.problems, ...review.problems].join("\n- ")}`;
      code = codeChecks(shape(await gptJson(DRAFT_SYSTEM, fix, usage, Math.min(30_000, left() - 5_000))), g);
      review = await judge(g, code.cleaned, usage, cfg.jev, left());
      if (!code.problems.length && !review.problems.length) status = "revised";
    }
  }

  return done({
    status,
    ...code.cleaned,
    examples: code.cleaned.examples.length ? code.cleaned.examples : g.urls.slice(0, 3),
    checks: [...code.checks, ...review.checks],
  });
}
