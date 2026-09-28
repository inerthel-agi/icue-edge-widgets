(() => {
    "use strict";

    const POLL_MS = 2500;
    const $ = id => document.getElementById(id);

    let api = null;
    let requestId = 1;
    let selectedId = "";
    let pollTimer = null;
    let initialized = false;
    let pluginInstance = null;
    let generation = 0;
    let busy = false;
    let selectionKey = "";

    function selection() {
        const automatic = typeof coolingAuto === "undefined" || coolingAuto !== false;
        const id = typeof coolingSensor === "string" ? coolingSensor.trim() : "";
        return { automatic, id };
    }

    function getPlugin() {
        return window.plugins && window.plugins.Sensorsdataprovider;
    }

    function invalidate() {
        generation++;
        currentMeta = null;
        selectedId = "";
        busy = false;
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

    function normalize(value) {
        return String(value || "").toLowerCase();
    }

    function scoreSensor(meta) {
        const haystack = normalize(`${meta.id} ${meta.name} ${meta.device} ${meta.type} ${meta.kind}`);
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
        return Math.abs(number) >= 100 ? String(Math.round(number)) : number.toFixed(1);
    }

    function sensorLabel(meta) {
        if (!selection().automatic) return meta.name || "Sensor";
        const haystack = normalize(`${meta.id} ${meta.name} ${meta.type} ${meta.kind}`);
        if (haystack.includes("pump")) return "Pump";
        if (haystack.includes("gpu")) return "GPU Temp";
        if (haystack.includes("cpu")) return "CPU Temp";
        return meta.type === "temperature" ? "Temp" : "Sensor";
    }

    function accent(meta, value) {
        let number = Number.parseFloat(value);
        if (String(meta.units).replace("°", "").trim().toUpperCase() === "F") number = (number - 32) * 5 / 9;
        const isPump = /rpm/i.test(String(meta.units));
        if (isPump) return "#00c8ff";
        if (!Number.isFinite(number)) return "#7f8c8d";
        if (!/temperature/i.test(String(meta.type)) && !/^[°]?[cf]$/i.test(String(meta.units).trim())) return "#00c8ff";
        if (number >= 80) return "#ff4d4d";
        if (number >= 65) return "#ffb84d";
        return "#1db954";
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
        const ids = await client.request("getAllSensorIds");
        const list = parseIds(ids);
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

    let currentMeta = null;

    function renderValue(value) {
        if (!currentMeta) return;
        const color = accent(currentMeta, value);
        $("value").textContent = formatValue(value);
        $("units").textContent = currentMeta.units || "";
        $("label").textContent = sensorLabel(currentMeta);
        $("device").textContent = currentMeta.device || currentMeta.name || currentMeta.id;
        $("ring").style.setProperty("--accent", color);
        $("widget").dataset.state = Number.isFinite(Number.parseFloat(value)) ? "ready" : "offline";
    }

    async function update() {
        const client = ensureApi();
        const selected = selection();
        const key = selected.automatic ? "auto" : `manual:${selected.id}`;
        if (selectionKey !== key) { selectionKey = key; invalidate(); }
        if (!client) {
            $("widget").dataset.state = "offline";
            $("label").textContent = "Sensors";
            $("value").textContent = "--";
            $("units").textContent = "";
            $("device").textContent = "Plugin unavailable";
            return;
        }
        if (busy) return;
        busy = true;
        const epoch = generation;
        try {
            let meta = currentMeta;
            if (meta && typeof pluginInstance.sensorIsConnected === "function") {
                const connected = await client.request("sensorIsConnected", meta.id);
                if (connected === false || connected === "false") meta = null;
            }
            if (!meta && selected.automatic) meta = await chooseSensor(client);
            else if (!meta && selected.id) {
                const ids = parseIds(await client.request("getAllSensorIds"));
                const connected = ids.includes(selected.id) && (typeof pluginInstance.sensorIsConnected !== "function" ||
                    await client.request("sensorIsConnected", selected.id));
                if (connected && connected !== "false") meta = await metadata(selected.id, client);
            }
            if (epoch !== generation) return;
            currentMeta = meta;
            selectedId = meta ? meta.id : "";
            if (!meta) {
                $("widget").dataset.state = "empty";
                $("label").textContent = selected.automatic ? "Cooling" : "Manual sensor";
                $("value").textContent = "--";
                $("units").textContent = "";
                $("device").textContent = selected.automatic ? "No cooling sensor" : selected.id ? "Selected sensor unavailable" : "Choose a sensor in iCUE";
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
            $("value").textContent = "--";
            $("units").textContent = "";
            $("device").textContent = "Sensor unavailable. Retrying…";
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

    window.CoolingSensorPump = { start, update };
    window.icueEvents = { onICUEInitialized: start, onDataUpdated: update };
    window.pluginSensorsdataproviderEvents = { onInitialized: () => { start(); update(); } };

    if (typeof iCUE_initialized !== "undefined" && iCUE_initialized) start();
    if (typeof pluginSensorsdataprovider_initialized !== "undefined" && pluginSensorsdataprovider_initialized) start();
    if (!pollTimer) setTimeout(start, 500);
})();
