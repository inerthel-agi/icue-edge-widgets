// Estimated cost of the Claude and Codex tokens, for the AI cost page. Same prices and rules as the
// AI Cost widget (widgets/xeneon-edge/ai-cost/app.js at the repository root): keep the two in step.
(function () {
  "use strict";
  const HOUR = 3600e3, DAY = 24 * HOUR;

  // USD per million tokens: input, output, cache read, cache write (5 min). Public pricing pages, checked 3 Nov 2026.
  const PRICES = {
    claude: {
      fable: [10, 50, 0.25, 12.5], opus55: [4, 20, 0.2, 5], opus5: [5, 25, 0.5, 6.25], opus41: [15, 75, 1.5, 18.75],
      sonnet55: [2, 10, 0.1, 2.5], sonnet46: [3, 15, 0.3, 3.75], haiku55: [0.1, 0.5, 0.01, 0.125], haiku45: [1, 5, 0.1, 1.25], haiku35: [0.8, 4, 0.08, 1],
    },
    codex: {
      gpt56sol: [4, 20, 0.4, 0], gpt56terra: [2, 12, 0.2, 0], gpt56luna: [0.2, 1.2, 0.02, 0], gpt55: [5, 30, 0.5, 0], gpt54: [2.5, 15, 0.25, 0],
      gpt53codex: [1.75, 14, 0.175, 0], gpt5: [1.25, 10, 0.125, 0], gpt5mini: [0.25, 2, 0.025, 0],
    },
  };
  const NAMES = {
    fable: "Fable 5.x", opus55: "Opus 5.5", opus5: "Opus 4.5 to 5", opus41: "Opus 4 / 4.1", sonnet55: "Sonnet 5.x", sonnet46: "Sonnet 4.x",
    haiku55: "Haiku 5.5", haiku45: "Haiku 4.5", haiku35: "Haiku 3.5", gpt56sol: "GPT-5.6 Sol", gpt56terra: "GPT-5.6 Terra", gpt56luna: "GPT-5.6 Luna",
    gpt55: "GPT-5.5", gpt54: "GPT-5.4", gpt53codex: "GPT-5.3 Codex", gpt5: "GPT-5", gpt5mini: "GPT-5 mini",
  };

  function tierOf(provider, model) {
    const m = String(model || "").toLowerCase().replace(/[_\s]+/g, "-");
    if (provider === "claude") {
      if (/fable|mythos/.test(m)) return "fable";
      if (/opus/.test(m)) return /opus-?5-?5|opus-5\.5/.test(m) ? "opus55" : /opus-4(-1)?(-\d{8})?$/.test(m) ? "opus41" : "opus5";
      if (/haiku/.test(m)) return /haiku-?5/.test(m) ? "haiku55" : /3-?5/.test(m) ? "haiku35" : "haiku45";
      if (/sonnet/.test(m)) return /sonnet-?5/.test(m) ? "sonnet55" : "sonnet46";
      return "sonnet55";
    }
    if (/5\.6/.test(m)) return /luna/.test(m) ? "gpt56luna" : /terra/.test(m) ? "gpt56terra" : "gpt56sol";
    if (/5\.5/.test(m)) return "gpt55";
    if (/5\.4/.test(m)) return "gpt54";
    if (/5\.3/.test(m)) return "gpt53codex";
    if (/mini/.test(m)) return "gpt5mini";
    if (/gpt-?5/.test(m)) return "gpt5";
    return "gpt55";
  }

  const num = (v) => (Number.isFinite(v) ? v : 0);
  const cost = (t, p) => (num(t.input) * p[0] + num(t.output) * p[1] + num(t.cacheRead) * p[2] + num(t.cacheWrite) * p[3]) / 1e6;
  const tokens = (t) => num(t.input) + num(t.output) + num(t.cacheRead) + num(t.cacheWrite);

  /** Today (since local midnight), yesterday, month so far (UTC days), pace, per provider, and a 24 h series. */
  function summarize(wire, now = Date.now()) {
    const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
    const todayStart = midnight.getTime();
    const d = new Date(now), monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const monthDays = new Date(d.getUTCFullYear(), d.getUTCMonth() + 1, 0).getDate();
    const out = { today: 0, yesterday: 0, month: null, tokensToday: 0, providers: [], series: new Array(24).fill(0) };
    for (const id of ["claude", "codex"]) {
      const w = wire && wire.providers && wire.providers[id];
      if (!w) continue;
      const tier = tierOf(id, w.model && w.model.v), p = PRICES[id][tier];
      let today = 0, tok = 0;
      for (const h of w.hours || []) {
        const c = cost(h, p);
        if (h.start >= todayStart) { today += c; tok += tokens(h); }
        else if (h.start >= todayStart - DAY) out.yesterday += c;
        const age = Math.floor((now - h.start) / HOUR);
        if (age >= 0 && age < 24) out.series[23 - age] += c;
      }
      if (Array.isArray(w.days)) out.month = (out.month || 0) + w.days.filter((x) => x.start >= monthStart).reduce((s, x) => s + cost(x, p), 0);
      out.providers.push({ id, name: w.name, model: w.model ? w.model.v : null, tier: NAMES[tier], price: p, today, tokens: tok });
      out.today += today;
      out.tokensToday += tok;
    }
    out.pace = out.month === null ? null : out.month / Math.max(1, (now - monthStart) / DAY) * monthDays;
    return out;
  }

  const money = (v) => "$" + (v < 10 ? v.toFixed(2) : v < 1000 ? v.toFixed(1) : String(Math.round(v)));
  window.Costs = { summarize, tierOf, money, PRICES };
})();
