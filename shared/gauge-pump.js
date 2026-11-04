// Sensor side of the pump gauges (Racing Gauge Pump and FPS Gauge Pump), drawn by gauge-designs.js.
// <body data-kind="cooling"> picks a pump, CPU or GPU sensor; data-kind="fps" picks the FPS sensor.
(() => {
    "use strict";

    const POLL_MS = 2500;
    const KIND = document.body.dataset.kind === "fps" ? "fps" : "cooling";
    const $ = id => document.getElementById(id);

    let api = null, requestId = 1, selectedId = "", pollTimer = null, initialized = false;
    let pluginInstance = null, generation = 0, busy = false, currentMeta = null, measured = "";
    let gauge = null, gaugeKey = "", scale = null;
    const recent = [];   // FPS readings of the last minute, for the average and the low

    const setting = (name, fallback) => (typeof window[name] !== "undefined" && window[name] !== null && window[name] !== "" ? window[name] : fallback);

    const getPlugin = () => window.plugins && window.plugins.Sensorsdataprovider;

    function invalidate() {
        generation++;
        currentMeta = null;
        selectedId = "";
        busy = false;
        recent.length = 0;
    }

    function ensureApi() {
        const plugin = getPlugin();
        if (plugin === pluginInstance) return api;
        if (api) api.dispose();
        pluginInstance = plugin;
        api = null;
        invalidate();
        if (!plugin) return null;
        const pending = new Map(), connections = [];
        let disposed = false;
        function connect(signal, callback) {
            if (!signal || !signal.connect) return;
            const guarded = (...args) => { if (!disposed && pluginInstance === plugin) callback(...args); };
            signal.connect(guarded);
            connections.push([signal, guarded]);
        }
        connect(plugin.asyncResponse, (id, value) => {
            const entry = pending.get(id);
            if (!entry) return;
            pending.delete(id);
            clearTimeout(entry.timeout);
            entry.resolve(value);
        });
        api = {
            request(method, ...args) {
                return new Promise((resolve, reject) => {
                    const id = requestId++;
                    const timeout = setTimeout(() => {
                        pending.delete(id);
                        reject(new Error("sensor_timeout"));
                    }, 1800);
                    pending.set(id, { resolve, reject, timeout });
                    try { plugin[method](id, ...args); }
                    catch (error) { clearTimeout(timeout); pending.delete(id); reject(error); }
                });
            },
            dispose() {
                disposed = true;
                for (const entry of pending.values()) {
                    clearTimeout(entry.timeout);
                    entry.reject(new Error("plugin_disconnected"));
                }
                pending.clear();
                for (const [signal, callback] of connections) {
                    if (signal.disconnect) signal.disconnect(callback);
                }
            }
        };
        connect(plugin.sensorValueChanged, (id, value) => { if (id === selectedId) renderValue(value); });
        connect(plugin.sensorRemoved, id => { if (id === selectedId) { invalidate(); update(); } });
        connect(plugin.sensorAdded, () => { invalidate(); update(); });
        connect(plugin.sensorUnitsChanged, id => { if (id === selectedId) update(); });
        return api;
    }

    const normalize = value => String(value || "").toLowerCase();

    // What the dial measures (Racing Gauge's Measure setting); "auto" keeps the cooling order below.
    // iCUE names the part in the id, not in the name: "vid<1b1c>pid<000002>…senstype<TemperaturePackage>" is the
    // CPU, pid<000007> a graphics card, and device names say "Intel Core" or "NVIDIA GeForce" (same rules as
    // shared/sensor-reader.js).
    const hay = m => normalize(`${m.id} ${m.name} ${m.device} ${m.type} ${m.kind}`);
    const has = (m, ...w) => w.some(x => hay(m).includes(x));
    const senstype = m => ((String(m.id).match(/senstype<([a-z]+)>/i) || [])[1] || "").toLowerCase();
    function part(m) {
        if (/vid<1b1c>pid<0*2>/i.test(m.id)) return "cpu";
        if (/vid<1b1c>pid<0*7>/i.test(m.id)) return "gpu";
        if (has(m, "gpu", "geforce", "nvidia", "radeon", "rtx", "gtx", "intel arc", "graphics")) return "gpu";
        if (has(m, "cpu", "processor", "ryzen", "intel core", "core i", "xeon", "threadripper", "package")) return "cpu";
        return "";
    }
    const isTemp = m => senstype(m).startsWith("temp") || has(m, "temperature", "temp") || /°|^\s*[cf]\s*$/i.test(String(m.units));
    const isLoad = m => senstype(m) === "load" || (!senstype(m) && (has(m, "load", "usage", "utili") || String(m.units).trim() === "%"));
    const isRpm = m => /rpm/i.test(String(m.units)) || has(m, "speed", "rpm");
    const notCooler = m => !has(m, "fan", "pump", "clock", "power", "voltage", "frequency");
    const MEASURES = {
        pump: ["Pump", m => has(m, "pump") && isRpm(m)],
        liquid: ["Coolant", m => has(m, "coolant", "liquid", "water") && isTemp(m)],
        cpu: ["CPU Temp", m => part(m) === "cpu" && notCooler(m) && isTemp(m)],
        gpu: ["GPU Temp", m => part(m) === "gpu" && notCooler(m) && isTemp(m)],
        cpuload: ["CPU Load", m => part(m) === "cpu" && notCooler(m) && !has(m, "memory", "ram ") && isLoad(m)],
        gpuload: ["GPU Load", m => part(m) === "gpu" && notCooler(m) && !has(m, "memory", "vram", "framebuffer") && isLoad(m)],
        fan: ["Fan", m => has(m, "fan") && !has(m, "pump") && isRpm(m)],
    };
    // Among matches: the CPU package over one core, a dedicated card over a chip's graphics.
    const preference = m => (senstype(m) === "temperaturepackage" ? 4 : 0) + (has(m, "package", "tctl", "total") ? 2 : 0)
        + (has(m, "geforce", "rtx", "radeon rx", "nvidia") ? 3 : 0) - (/index<[1-9]>/.test(m.id) ? 0.5 : 0);
    const measure = () => (KIND === "fps" ? "auto" : MEASURES[setting("gaugeMeasure", "auto")] ? setting("gaugeMeasure", "auto") : "auto");

    function scoreSensor(meta) {
        const haystack = normalize(`${meta.id} ${meta.name} ${meta.device} ${meta.type} ${meta.kind}`);
        if (KIND === "fps") return haystack.includes("fps") || haystack.includes("frames per second") ? 100 : 0;
        const m = measure();
        if (m !== "auto") return MEASURES[m][1](meta) ? 100 + preference(meta) : 0;
        if (haystack.includes("cpu-pump") || (haystack.includes("pump") && haystack.includes("cpu"))) return 100;
        if (haystack.includes("pump")) return 90;
        if (haystack.includes("cpu-temp") || (haystack.includes("temperature") && haystack.includes("cpu"))) return 80;
        if (haystack.includes("gpu-temp") || (haystack.includes("temperature") && haystack.includes("gpu"))) return 70;
        if (haystack.includes("temperature")) return 50;
        return 0;
    }

    function formatValue(value) {
        const number = Number.parseFloat(value);
        if (!Number.isFinite(number)) return "--";
        return KIND === "fps" || Math.abs(number) >= 100 ? String(Math.round(number)) : number.toFixed(1);
    }

    function sensorLabel(meta) {
        if (KIND === "fps") return "Frame rate";
        if (measure() !== "auto") return MEASURES[measure()][0];
        const haystack = normalize(`${meta.id} ${meta.name} ${meta.type} ${meta.kind}`);
        if (haystack.includes("pump")) return "Pump";
        if (haystack.includes("gpu")) return "GPU Temp";
        if (haystack.includes("cpu")) return "CPU Temp";
        return meta.type === "temperature" ? "Temp" : "Sensor";
    }

    async function metadata(id, client) {
        const [name, device, type, kind, units] = await Promise.all([
            client.request("getSensorName", id),
            client.request("getSensorDeviceName", id),
            client.request("getSensorType", id),
            client.request("getSensorKind", id),
            client.request("getSensorUnits", id)
        ]);
        return { id, name, device, type, kind, units };
    }

    async function chooseSensor(client) {
        if (!client) return null;
        const list = parseIds(await client.request("getAllSensorIds"));
        if (!list.length) return null;
        // One slow or failing sensor must not hide all the others.
        const settled = await Promise.allSettled(list.map(id => metadata(id, client)));
        const metas = settled.filter(r => r.status === "fulfilled" && r.value).map(r => r.value);
        metas.sort((a, b) => scoreSensor(b) - scoreSensor(a));
        return metas[0] && scoreSensor(metas[0]) > 0 ? metas[0] : null;
    }

    function parseIds(ids) {
        if (Array.isArray(ids)) return ids;
        if (typeof ids !== "string" || !ids.trim()) return [];
        try {
            const parsed = JSON.parse(ids);
            return Array.isArray(parsed) ? parsed : [];
        } catch (_) {
            return ids.split(",").map(id => id.trim()).filter(Boolean);
        }
    }

    // ---------- scale ----------
    function niceCeil(v) {
        const mag = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1))));
        for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= v) return m * mag;
        return 10 * mag;
    }

    /** min, max, redline (value), majors, and how a value prints on the dial. */
    function scaleFor(meta, number) {
        if (KIND === "fps") {
            // Round scales, so the dial reads 0 / 60 / 120…: a 144 or 165 Hz game sits on the 180 dial.
            const max = [60, 120, 180, 240, 360, 480, 600].find(m => m >= number * 1.05) || niceCeil(number * 1.2);
            return make("fps" + max, 0, max, Infinity, [120, 240, 480].includes(max) ? 4 : 6, 1, 0);
        }
        const units = String(meta.units || "").trim();
        const bare = units.replace("°", "").toUpperCase();
        if (/rpm/i.test(units)) {
            const max = number > 4500 ? niceCeil(number * 1.2) : 5000;
            return make("rpm" + max, 0, max, max * 0.9, 5, 1000, 1);
        }
        if (bare === "F") return make("tempF", 68, 176, 149, 6, 1, 0);
        if (bare === "C" || /temperature/i.test(String(meta.type))) return make("tempC", 20, 80, 65, 6, 1, 0);
        if (bare === "%") return make("percent", 0, 100, 90, 5, 1, 0);
        const max = niceCeil(Math.max(number, 1) * 1.5);
        return make("other" + max, 0, max, max * 0.9, 5, 1, 0);
    }

    function make(key, min, max, red, parts, divide, digits) {
        const ratio = v => Math.min(Math.max((v - min) / (max - min), 0), 1);
        return {
            key, min, max,
            red: red === Infinity ? 2 : ratio(red),   // 2: no redline
            majors: Array.from({ length: parts + 1 }, (_, i) => min + (max - min) * i / parts),
            ratio,
            // Dial numbers (rpm in thousands); `rolling` is the value shown while the needle moves.
            label: (v, rolling) => rolling ? formatValue(v) : String(Math.round(v / divide * 10 ** digits) / 10 ** digits),
        };
    }

    // ---------- drawing ----------
    function design() {
        const d = String(setting("gaugeDesign", KIND === "fps" ? "fps" : "classic"));
        return window.GaugeDesigns.list.includes(d) ? d : "classic";
    }

    function ensureGauge(sc) {
        const key = `${design()}|${sc.key}`;
        if (key === gaugeKey && gauge) return gauge;
        if (gauge) gauge.destroy();
        gaugeKey = key;
        scale = sc;
        gauge = window.GaugeDesigns.mount($("gauge"), design(), sc);
        return gauge;
    }

    function showIdle(label, device) {
        const g = ensureGauge(scale || (KIND === "fps" ? scaleFor({}, 100) : scaleFor({ units: "°C", type: "temperature" }, 30)));
        g.info(label, "", device);
        g.set(NaN, "--");
        if (KIND === "fps") g.fps(false, "", device);
    }

    function renderValue(value) {
        if (!currentMeta) return;
        const number = Number.parseFloat(value);
        if (!Number.isFinite(number)) { $("widget").dataset.state = "offline"; showIdle(sensorLabel(currentMeta), "No reading"); return; }
        // Outside a game iCUE reports -1 (or 0): an empty dial, not a frame rate.
        if (KIND === "fps" && number <= 0) { recent.length = 0; $("widget").dataset.state = "empty"; showIdle("Frame rate", "No game running"); return; }
        // The scale only changes when the reading leaves it (or falls far below an FPS scale): no redraw per reading.
        const fresh = scaleFor(currentMeta, number);
        const family = k => k.replace(/\d+$/, "");
        let sc = scale;
        if (!sc || family(sc.key) !== family(fresh.key) || number > sc.max || (KIND === "fps" && number < sc.max * 0.4)) sc = fresh;
        const g = ensureGauge(sc);
        const units = KIND === "fps" ? "FPS" : currentMeta.units || "";
        g.info(sensorLabel(currentMeta), units, currentMeta.device || currentMeta.name || currentMeta.id);
        g.set(number, formatValue(number));
        if (KIND === "fps") {
            recent.push(number);
            if (recent.length > 60) recent.shift();
            const avg = Math.round(recent.reduce((a, b) => a + b, 0) / recent.length);
            g.fps(true, `Average ${avg} · last minute`, `Low ${Math.round(Math.min(...recent))} · last minute`);
        }
        $("widget").dataset.state = "ready";
    }

    async function update() {
        const client = ensureApi();
        if (!client) {
            $("widget").dataset.state = "offline";
            showIdle(KIND === "fps" ? "FPS" : "Sensors", "Plugin unavailable");
            return;
        }
        // A new Measure choice drops the current sensor and looks again.
        if (measured !== measure()) { measured = measure(); invalidate(); }
        if (busy) return;
        busy = true;
        const epoch = generation;
        try {
            let meta = currentMeta;
            if (meta && typeof pluginInstance.sensorIsConnected === "function") {
                const connected = await client.request("sensorIsConnected", meta.id);
                if (connected === false || connected === "false") meta = null;
            }
            if (!meta) meta = await chooseSensor(client);
            if (epoch !== generation) return;
            currentMeta = meta;
            selectedId = meta ? meta.id : "";
            if (!meta) {
                $("widget").dataset.state = "empty";
                const m = measure();
                const none = KIND === "fps" ? "No FPS sensor: start a game" : m === "auto" ? "No cooling sensor" : "No " + MEASURES[m][0] + " sensor in iCUE";
                showIdle(KIND === "fps" ? "FPS" : m === "auto" ? "Cooling" : MEASURES[m][0], none);
                return;
            }
            const [value, units] = await Promise.all([
                client.request("getSensorValue", meta.id), client.request("getSensorUnits", meta.id)
            ]);
            if (epoch !== generation) return;
            meta.units = units;
            renderValue(value);
        } catch (_) {
            if (epoch !== generation) return;
            currentMeta = null;
            selectedId = "";
            $("widget").dataset.state = "offline";
            showIdle(KIND === "fps" ? "FPS" : "Sensors", "Sensor unavailable. Retrying…");
        } finally {
            if (epoch === generation) busy = false;
        }
    }

    function start() {
        if (initialized) return;
        initialized = true;
        update();
        pollTimer = setInterval(update, POLL_MS);
    }

    // The design setting applies at the next reading; onDataUpdated asks for one now.
    window.GaugePump = { start, update, scaleFor };
    window.RacingGaugePump = window.GaugePump;
    window.icueEvents = { onICUEInitialized: start, onDataUpdated: update };
    window.pluginSensorsdataproviderEvents = { onInitialized: () => { start(); update(); } };

    if (typeof iCUE_initialized !== "undefined" && iCUE_initialized) start();
    if (typeof pluginSensorsdataprovider_initialized !== "undefined" && pluginSensorsdataprovider_initialized) start();
    if (!pollTimer) setTimeout(start, 500);
})();
