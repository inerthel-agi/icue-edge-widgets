// Reads several iCUE sensors at once for System Pulse and Rig Pet: CPU and GPU load and temperature,
// RAM and VRAM use, and the game's frame rate. Each role takes the best-named sensor iCUE offers; a missing role stays null.
// SensorReader.watch(fn) calls fn({ cpuLoad, cpuTemp, gpuLoad, gpuTemp, ram, vram }) every 1.5 s, each a
// { value, units, name } or null, plus { plugin: false } when the iCUE Sensors plugin is not there.
// ?demo in the address gives moving made-up values, for the previews.
(() => {
    "use strict";

    const POLL_MS = 1500, FIND_MS = 60000;
    // iCUE ids name the part and the kind: "vid<1b1c>pid<000002>…senstype<TemperaturePackage>…" is the CPU,
    // pid<000007> a graphics card. The device name ("Intel Core…", "NVIDIA GeForce…") rarely says CPU or GPU.
    const ROLES = {
        cpuLoad: m => part(m) === "cpu" && kind(m) === "load",
        cpuTemp: m => part(m) === "cpu" && kind(m) === "temp",
        gpuLoad: m => part(m) === "gpu" && kind(m) === "load",
        gpuTemp: m => part(m) === "gpu" && kind(m) === "temp",
        ram: m => part(m) !== "gpu" && kind(m) === "memory",
        vram: m => part(m) === "gpu" && (kind(m) === "framebuffer" || (kind(m) === "memory" && has(m, "vram", "dedicated"))),
        fps: m => kind(m) === "fps",
        // Watercooling: coolant temperature, pump speed and a room probe, when the hardware has them.
        liquid: m => has(m, "coolant", "liquid", "water") && isTemp(m),
        pump: m => has(m, "pump") && (/rpm/i.test(String(m.units)) || has(m, "speed")),
        air: m => has(m, "ambient", "room", "intake") && isTemp(m),
        // Power draw in watts, for Energy Cost.
        cpuPower: m => part(m) === "cpu" && isPower(m),
        gpuPower: m => part(m) === "gpu" && isPower(m),
    };
    const isPower = m => !has(m, "limit", "voltage") && (senstype(m).startsWith("power") || has(m, "power", "watt") || /^\s*w\s*$/i.test(String(m.units)));
    const isTemp = m => senstype(m).startsWith("temp") || has(m, "temperature", "temp") || /°|^\s*[cf]\s*$/i.test(String(m.units));

    const hay = m => `${m.id} ${m.name} ${m.device} ${m.type} ${m.kind}`.toLowerCase();
    const has = (m, ...words) => words.some(w => hay(m).includes(w));
    const senstype = m => ((String(m.id).match(/senstype<([a-z]+)>/i) || [])[1] || "").toLowerCase();
    function part(m) {
        if (/vid<1b1c>pid<0*2>/i.test(m.id)) return "cpu";
        if (/vid<1b1c>pid<0*7>/i.test(m.id)) return "gpu";
        // Graphics words first: "AMD Radeon" and "Intel Arc" are cards, "AMD Ryzen" and "Intel Core" are not.
        if (has(m, "gpu", "geforce", "nvidia", "radeon", "rtx", "gtx", "intel arc", "graphics")) return "gpu";
        if (has(m, "cpu", "processor", "ryzen", "intel core", "core i", "xeon", "threadripper", "package")) return "cpu";
        return "";
    }
    function kind(m) {
        const t = senstype(m);
        if (t === "fps" || has(m, "fps", "framerate", "frame rate")) return "fps";
        if (has(m, "fan", "pump", "clock", "power", "voltage", "frequency")) return "";
        if (t.startsWith("temperature") || t === "temp") return "temp";
        if (t === "framebufferload") return "framebuffer";
        if (t === "load") return "load";
        if (t) return t === "memoryload" && part(m) !== "gpu" ? "memory" : "";
        // No senstype in the id: from the name, type and units.
        if (has(m, "temperature", "temp") || /°|^\s*[cf]\s*$/i.test(String(m.units))) return "temp";
        if (has(m, "memory", "ram ", "vram") && (has(m, "load", "usage", "used") || String(m.units).trim() === "%")) return "memory";
        if (has(m, "load", "usage", "utili") || String(m.units).trim() === "%") return "load";
        return "";
    }
    // Among sensors of one role: the CPU package over one core, a dedicated card over a chip's graphics.
    const score = m => (senstype(m) === "temperaturepackage" ? 4 : 0) + (has(m, "package", "tctl", "total") ? 2 : 0)
        + (has(m, "geforce", "rtx", "radeon rx", "nvidia") ? 3 : 0) - (/index<[1-9]>/.test(m.id) ? 0.5 : 0);

    let api = null, plugin = null, requestId = 1, chosen = null, foundAt = 0;
    const listeners = [];

    function client(p) {
        const pending = new Map();
        if (p.asyncResponse && p.asyncResponse.connect) {
            p.asyncResponse.connect((id, value) => {
                const e = pending.get(id);
                if (!e) return;
                pending.delete(id);
                clearTimeout(e.t);
                e.resolve(value);
            });
        }
        if (p.sensorAdded && p.sensorAdded.connect) p.sensorAdded.connect(() => { foundAt = 0; });
        if (p.sensorRemoved && p.sensorRemoved.connect) p.sensorRemoved.connect(() => { foundAt = 0; });
        return (method, ...args) => new Promise((resolve, reject) => {
            const id = requestId++;
            const t = setTimeout(() => { pending.delete(id); reject(new Error("sensor_timeout")); }, 1800);
            pending.set(id, { resolve, t });
            try { p[method](id, ...args); } catch (e) { clearTimeout(t); pending.delete(id); reject(e); }
        });
    }

    function ids(raw) {
        if (Array.isArray(raw)) return raw;
        if (typeof raw !== "string" || !raw.trim()) return [];
        try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch (_) { return raw.split(",").map(s => s.trim()).filter(Boolean); }
    }

    async function find(req) {
        const list = ids(await req("getAllSensorIds"));
        const metas = (await Promise.allSettled(list.map(async id => {
            const [name, device, type, kind, units] = await Promise.all(["getSensorName", "getSensorDeviceName", "getSensorType", "getSensorKind", "getSensorUnits"].map(f => req(f, id)));
            return { id, name, device, type, kind, units };
        }))).filter(r => r.status === "fulfilled").map(r => r.value);
        const out = {};
        for (const [role, test] of Object.entries(ROLES)) {
            const hits = metas.filter(test).sort((a, b) => score(b) - score(a));
            out[role] = hits[0] || null;
        }
        return out;
    }

    async function read() {
        const p = window.plugins && window.plugins.Sensorsdataprovider;
        if (!p) return { plugin: false };
        if (p !== plugin) { plugin = p; api = client(p); foundAt = 0; }
        if (!chosen || Date.now() - foundAt > FIND_MS) { chosen = await find(api); foundAt = Date.now(); }
        const out = { plugin: true };
        await Promise.all(Object.entries(chosen).map(async ([role, m]) => {
            out[role] = null;
            if (!m) return;
            try {
                const v = Number.parseFloat(await api("getSensorValue", m.id));
                if (Number.isFinite(v)) out[role] = { value: v, units: m.units || "", name: m.name || m.device || "" };
            } catch (_) { /* stays null this round */ }
        }));
        return out;
    }

    function demo() {
        const t = Date.now() / 1000, wave = (base, amp, speed) => base + amp * Math.sin(t * speed) + amp * 0.4 * Math.sin(t * speed * 3.7);
        const load = (b, a, s) => ({ value: Math.max(1, Math.min(100, wave(b, a, s))), units: "%", name: "Demo" });
        const temp = (b, a, s) => ({ value: wave(b, a, s), units: "°C", name: "Demo" });
        const params = new URLSearchParams(location.search);
        const hot = params.get("demo") === "hot" ? 24 : 0;
        const watts = (b, a, s) => ({ value: Math.max(5, wave(b, a, s)), units: "W", name: "Demo" });
        return { plugin: true, cpuPower: watts(70 + hot * 3, 30, 0.2), gpuPower: watts(160 + hot * 6, 90, 0.13), liquid: temp(33 + hot / 3, 3, 0.1), pump: { value: wave(2600, 400, 0.15), units: "RPM", name: "Demo" }, air: null,
            fps: params.get("demo") === "game" ? { value: 144, units: "FPS", name: "Demo" } : null, cpuLoad: load(38 + hot, 22, 0.35), cpuTemp: temp(56 + hot, 8, 0.12), gpuLoad: load(62 + hot, 30, 0.22), gpuTemp: temp(64 + hot, 9, 0.09), ram: load(54, 4, 0.05), vram: load(41, 6, 0.07) };
    }

    let busy = false, timer = null;
    async function tick() {
        if (busy) return;
        busy = true;
        let r;
        try { r = /[?&]demo\b/.test(location.search) ? demo() : await read(); } catch (_) { r = { plugin: true }; chosen = null; }
        busy = false;
        for (const fn of listeners) { try { fn(r); } catch (_) { /* one widget's bug must not stop the reader */ } }
    }

    function watch(fn) {
        listeners.push(fn);
        if (!timer) { timer = setInterval(tick, POLL_MS); setTimeout(tick, 300); }
    }

    window.SensorReader = { watch, roles: ROLES };
    window.pluginSensorsdataproviderEvents = { onInitialized: () => { foundAt = 0; tick(); } };
})();
