// Animated round gauges for the 480 x 480 pump LCD (colours in gauge-designs.css): one SVG per design and a spring-driven needle.
// mount(svg, designId, scale) draws the face; the returned controller takes sensor readings with set().
// A reading arrives about once a second; between readings the needle swings with a small overshoot,
// numbers roll with it, and the loop stops once it has settled (iCUE draws widgets at ~30 fps).
(() => {
    "use strict";

    const C = 240, A0 = 135, SWEEP = 270;
    const rad = d => d * Math.PI / 180;
    const P = (r, deg) => [C + r * Math.cos(rad(deg)), C + r * Math.sin(rad(deg))];
    const ang = t => A0 + SWEEP * t;
    const f = n => n.toFixed(1);
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

    function arc(r, t0, t1) {
        const s = P(r, ang(t0)), e = P(r, ang(t1));
        return `M${f(s[0])} ${f(s[1])}A${r} ${r} 0 ${SWEEP * (t1 - t0) > 180 ? 1 : 0} 1 ${f(e[0])} ${f(e[1])}`;
    }
    function ticks(n, r1, r2, cls) {
        let s = "";
        for (let i = 0; i <= n; i++) {
            const t = i / n, [x1, y1] = P(r1, ang(t)), [x2, y2] = P(r2, ang(t));
            s += `<line class="${typeof cls === "function" ? cls(t) : cls}" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}"/>`;
        }
        return s;
    }
    const numbers = (sc, r, cls) => sc.majors.map(v => {
        const [x, y] = P(r, ang(sc.ratio(v)));
        return `<text class="${cls}" x="${f(x)}" y="${f(y)}">${esc(sc.label(v))}</text>`;
    }).join("");
    const needle = (len, tail, w, cls) => `<path id="n" class="${cls}" d="M${C - tail} ${C - w / 2}L${C + len} ${C - 1.2}L${C + len} ${C + 1.2}L${C - tail} ${C + w / 2}Z"/>`;
    const fill = (r, cls, id = "a") => `<path id="${id}" class="${cls}" pathLength="1" stroke-dasharray="0 1" d="${arc(r, 0, 1)}"/>`;
    const texts = (y, cls = "") => `<text id="lb" class="lb ${cls}" x="240" y="${y[0]}"></text><text id="v" class="v blink" x="240" y="${y[1]}">--</text>` +
        `<text id="u" class="u" x="240" y="${y[2]}"></text><text id="dv" class="dv" x="240" y="${y[3]}"></text>`;

    /* Each design is a function of the scale (sc.red is a 0..1 ratio). Ids the controller drives:
       n needle, a / a2 filled arcs, v value, u units, lb label, dv device, seg* segments,
       sl* shift lights, heat glow, hist history line, sub / bt FPS lines. */
    const DESIGNS = {
        classic: sc => `
            <circle class="rim" cx="240" cy="240" r="236"/>
            <path class="track" d="${arc(190, 0, 1)}"/>${fill(190, "progress")}
            <path class="redarc" d="${arc(204, sc.red, 1)}"/>
            ${ticks(20, 196, 182, t => `tick${t >= sc.red ? " red" : ""}`)}${ticks(sc.majors.length - 1, 196, 168, t => `tick major${t >= sc.red ? " red" : ""}`)}
            ${numbers(sc, 140, "num")}
            ${needle(170, 26, 8, "needle")}<circle class="hub" cx="240" cy="240" r="14"/>
            ${texts([402, 318, 352, 430])}`,

        race: sc => `
            <g class="g-race"><rect width="480" height="480" fill="#050505"/>
            ${Array.from({ length: 30 }, (_, i) => `<path id="seg${i}" class="seg" d="${arc(196, i / 30 + 0.004, (i + 1) / 30 - 0.004)}"/>`).join("")}
            ${numbers(sc, 150, "num")}
            ${Array.from({ length: 10 }, (_, i) => `<circle id="sl${i}" class="sl" cx="${151 + i * 20}" cy="96" r="7"/>`).join("")}
            ${texts([168, 252, 330, 372])}</g>`,

        munich: sc => `
            <g class="g-mu"><radialGradient id="muFace"><stop offset=".55" stop-color="#121417"/><stop offset="1" stop-color="#050506"/></radialGradient>
            <rect width="480" height="480" fill="url(#muFace)"/>
            <path d="${arc(206, sc.red, 1)}" stroke="#e8231a" stroke-width="16" fill="none"/>
            ${ticks(40, 200, 212, t => "t" + (t >= sc.red ? " r" : ""))}${ticks(sc.majors.length - 1, 190, 212, t => "t big" + (t >= sc.red ? " r" : ""))}
            ${numbers(sc, 160, "num")}
            <g transform="translate(209 396)"><rect width="18" height="30" fill="#4cb0e6"/><rect x="22" width="18" height="30" fill="#1c3f94"/><rect x="44" width="18" height="30" fill="#e2231a"/></g>
            ${texts([296, 336, 368, 0])}
            ${needle(196, 34, 12, "nd")}<circle cx="240" cy="240" r="24" fill="#1a1c20" stroke="#2c2f35" stroke-width="3"/></g>`,

        stuttgart: sc => `
            <g class="g-st"><linearGradient id="stChrome" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f6f8"/><stop offset=".45" stop-color="#6b7078"/><stop offset=".55" stop-color="#2a2d32"/><stop offset="1" stop-color="#c9cdd3"/></linearGradient>
            <radialGradient id="stFace"><stop offset="0" stop-color="#16202e"/><stop offset="1" stop-color="#05070b"/></radialGradient>
            <radialGradient id="stGlow"><stop offset=".6" stop-color="#4f9bff" stop-opacity="0"/><stop offset=".92" stop-color="#4f9bff" stop-opacity=".55"/><stop offset="1" stop-color="#4f9bff" stop-opacity="0"/></radialGradient>
            <rect width="480" height="480" fill="#000"/><circle cx="240" cy="240" r="236" fill="url(#stChrome)"/><circle cx="240" cy="240" r="222" fill="url(#stFace)"/>
            <circle id="heat" cx="240" cy="240" r="222" fill="url(#stGlow)" opacity=".2"/>
            ${ticks(50, 196, 206, "t")}${ticks(sc.majors.length - 1, 184, 208, "t big")}
            ${numbers(sc, 160, "num")}
            ${texts([296, 360, 322, 0])}
            ${needle(200, 40, 7, "nd")}<circle cx="240" cy="240" r="20" fill="url(#stChrome)"/><circle cx="240" cy="240" r="13" fill="#0b0e13"/></g>`,

        gr: sc => `
            <g class="g-gr"><rect width="480" height="480" fill="#070707"/>
            <path class="bar" d="${arc(190, 0, 1)}"/>${fill(190, "fill")}
            <path d="${arc(214, sc.red, 1)}" fill="none" stroke="#eb0a1e" stroke-width="6"/>
            ${numbers(sc, 150, "num")}
            <path d="M150 384L330 384L322 396L142 396Z" fill="#eb0a1e"/>
            ${texts([178, 262, 338, 0])}</g>`,

        gtr: sc => `
            <g class="g-gt"><rect width="480" height="480" fill="#020809"/>
            ${Array.from({ length: 22 }, (_, i) => `<rect id="seg${i}" class="seg" x="${86 + i * 14}" y="${110 - Math.round(i * i * 0.08)}" width="10" height="${30 + Math.round(i * i * 0.08)}" rx="1"/>`).join("")}
            ${texts([168, 232, 284, 404])}
            <g transform="translate(110 316)">${Array.from({ length: 5 }, (_, i) => `<line class="grid" x1="0" x2="260" y1="${i * 15}" y2="${i * 15}"/>`).join("")}<path id="hist" d=""/></g></g>`,

        maranello: sc => `
            <g class="g-ma"><radialGradient id="maFace"><stop offset=".7" stop-color="#ffd21f"/><stop offset="1" stop-color="#e2a800"/></radialGradient>
            <rect width="480" height="480" fill="#111"/><circle cx="240" cy="240" r="228" fill="url(#maFace)"/>
            <path d="${arc(206, sc.red, 1)}" stroke="#d40000" stroke-width="14" fill="none"/>
            ${ticks(50, 198, 212, "t")}${ticks(sc.majors.length - 1, 186, 212, "t big")}
            ${numbers(sc, 160, "num")}
            <rect x="190" y="334" width="100" height="40" rx="4" fill="#111"/>
            ${texts([304, 355, 392, 0])}
            ${needle(204, 30, 10, "nd")}<circle cx="240" cy="240" r="22" fill="#111"/><circle cx="240" cy="240" r="8" fill="#333"/></g>`,

        fps: sc => `
            <g class="g-fp" id="fp"><rect width="480" height="480" fill="#050606"/>
            <path class="trk" d="${arc(198, 0, 1)}"/>${fill(198, "disp")}
            <path class="trk2" d="${arc(170, 0, 1)}"/>${fill(170, "rend", "a2")}
            ${numbers(sc, 140, "num")}
            <rect class="badge" x="140" y="128" width="200" height="34" rx="17"/><text id="bt" class="bt" x="240" y="146">FPS</text>
            ${texts([0, 236, 304, 420])}<text id="sub" class="sub" x="240" y="394"></text></g>`,
    };

    const reduced = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

    /** Draws `design` for scale `sc` into `svg` and returns { set(value, text), info(label, units, device), gen(n) }. */
    function mount(svg, design, sc) {
        const make = DESIGNS[design] || DESIGNS.classic;
        svg.innerHTML = make(sc);
        const q = id => svg.querySelector("#" + id);
        const el = { n: q("n"), a: q("a"), a2: q("a2"), v: q("v"), u: q("u"), lb: q("lb"), dv: q("dv"), heat: q("heat"), hist: q("hist"), sub: q("sub"), bt: q("bt"), fp: q("fp") };
        const segs = [...svg.querySelectorAll("[id^=seg]")], sls = [...svg.querySelectorAll("[id^=sl]")];
        const history = [];
        let x = 0, vel = 0, goal = 0, text = "--", frame = 0, last = 0, multiplier = 1, value = NaN;
        let sweepUntil = reduced() ? 0 : performance.now() + 1500;   // start-up sweep: 0 → max → reading

        function draw(t, settled) {
            const c = Math.max(0, Math.min(1, t));
            if (el.n) el.n.setAttribute("transform", `rotate(${f(ang(Math.max(-0.01, Math.min(1.02, t))))} 240 240)`);
            if (el.a) el.a.setAttribute("stroke-dasharray", `${c.toFixed(4)} 1`);
            if (el.a2) el.a2.setAttribute("stroke-dasharray", `${(c / multiplier).toFixed(4)} 1`);
            if (el.v) el.v.textContent = settled ? text : sc.label(sc.min + (sc.max - sc.min) * c, true);
            if (el.heat) el.heat.setAttribute("opacity", (0.15 + c * 0.85).toFixed(2));
            const hot = c >= sc.red;
            svg.classList.toggle("redline", hot && Number.isFinite(value));
            segs.forEach((s, i) => {
                const on = (i + 0.5) / segs.length <= c, red = (i + 1) / segs.length > sc.red;
                s.classList.toggle("on", on && !red); s.classList.toggle("hot", on && red);
            });
            const lit = Math.round(((c - 0.55) / Math.max(0.05, sc.red - 0.55)) * sls.length);
            sls.forEach((s, i) => s.setAttribute("class", "sl" + (hot || i >= lit ? "" : i < sls.length * 0.4 ? " g" : i < sls.length * 0.8 ? " y" : " r")));
        }

        function tick(now) {
            frame = 0;
            const dt = Math.min(0.05, (now - (last || now)) / 1000);
            last = now;
            const sweeping = now < sweepUntil;
            const target = sweeping ? 1 - Math.abs(((sweepUntil - now) / 1500) * 2 - 1) : goal;
            if (reduced()) { x = target; vel = 0; }
            else {
                // Under-damped spring: a quick swing and a small overshoot, like a real needle.
                vel += ((target - x) * 120 - vel * 16) * dt;
                x += vel * dt;
            }
            const settled = !sweeping && Math.abs(target - x) < 0.0005 && Math.abs(vel) < 0.002;
            if (settled) x = target;
            draw(x, settled);
            if (!settled) frame = requestAnimationFrame(tick); else last = 0;
        }
        const wake = () => { if (!frame) frame = requestAnimationFrame(tick); };

        draw(0, false);
        wake();
        return {
            set(v, shown) {
                value = v;
                text = shown;
                goal = Number.isFinite(v) ? sc.ratio(v) : 0;
                if (el.hist && Number.isFinite(v)) {
                    history.push(sc.ratio(v));
                    if (history.length > 60) history.shift();
                    el.hist.setAttribute("d", history.map((h, i) => `${i ? "L" : "M"}${f(260 - (history.length - 1 - i) * (260 / 59))} ${f(60 - h * 60)}`).join(""));
                }
                wake();
            },
            info(label, units, device) {
                if (el.lb) el.lb.textContent = label;
                if (el.u) el.u.textContent = units;
                if (el.dv) el.dv.textContent = device;
            },
            /** FPS only: frame-generation multiplier (1 = native), and the lines under the number. */
            fps(n, sub, low, dynamic) {
                multiplier = Math.max(1, n);
                if (el.fp) el.fp.classList.toggle("gen", multiplier > 1);
                const mode = n === 0 ? "NO GAME" : multiplier === 1 ? "NATIVE" : multiplier === 2 ? "FG 2×" : `MFG ${multiplier}×`;
                if (el.bt) el.bt.textContent = dynamic && n ? `DYNAMIC · ${mode}` : mode;
                if (el.sub) el.sub.textContent = sub;
                if (el.dv) el.dv.textContent = low;
                wake();
            },
            destroy() { if (frame) cancelAnimationFrame(frame); frame = 0; },
        };
    }

    window.GaugeDesigns = { mount, list: Object.keys(DESIGNS) };
})();
