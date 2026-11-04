(() => {
    "use strict";

    const POLL_MS = 15 * 60 * 1000;
    const $ = id => document.getElementById(id);
    let timer = null;
    let retryTimer = null;
    let failures = 0;
    let hasLiveData = false;

    let updateSeq = 0;
    let request = null;
    let settingsTimer = null;
    let activeKey = "";
    let notBefore = 0;
    let lastUpdated = 0;

    async function getJson(url, signal) {
        return (await WidgetRuntime.requestJson(url, { signal })).data;
    }

    let status = "Loading";

    // Signature: a brass weather station. A thermometer dial (-20 to 40 °C) whose needle shows the temperature,
    // and the barometer's words, the one matching the sky lit.
    const NS = "http://www.w3.org/2000/svg";
    const WORDS = ["STORMY", "RAIN", "CHANGE", "FAIR", "VERY DRY"];
    let dial = null;
    function station(temp, code) {
        if (typeof document.querySelector !== "function") return;   // test harness without a full DOM
        const hero = document.querySelector(".hero");
        if (!hero || typeof document.createElementNS !== "function") return;
        if (!dial) {
            const mk = (tag, a, parent) => { const n = document.createElementNS(NS, tag); for (const k in a) n.setAttribute(k, a[k]); parent.append(n); return n; };
            const s = mk("svg", { class: "station", viewBox: "0 0 200 200", "aria-hidden": "true" }, hero);
            mk("circle", { class: "st-rim", cx: 100, cy: 100, r: 96 }, s);
            mk("circle", { class: "st-face", cx: 100, cy: 100, r: 84 }, s);
            for (let v = -20; v <= 40; v += 5) {
                const a = (-135 + (v + 20) / 60 * 270) * Math.PI / 180, big = v % 10 === 0;
                mk("line", { class: big ? "st-tk big" : "st-tk", x1: 100 + Math.sin(a) * (big ? 66 : 70), y1: 100 - Math.cos(a) * (big ? 66 : 70), x2: 100 + Math.sin(a) * 78, y2: 100 - Math.cos(a) * 78 }, s);
                if (big) { const t = mk("text", { class: "st-num", x: 100 + Math.sin(a) * 56, y: 100 - Math.cos(a) * 56 }, s); t.textContent = String(v); }
            }
            const words = WORDS.map((w, i) => { const t = mk("text", { class: "st-word", x: 100, y: 0, transform: `rotate(${-60 + i * 30} 100 100)` }, s); t.setAttribute("y", "72"); t.textContent = w; return t; });
            const needle = mk("path", { class: "st-nd", d: "M100 30 L104 100 L100 116 L96 100 Z" }, s);
            mk("circle", { class: "st-hub", cx: 100, cy: 100, r: 7 }, s);
            dial = { needle, words };
        }
        const t = Math.max(-20, Math.min(40, Number(temp)));
        if (Number.isFinite(t)) dial.needle.setAttribute("transform", `rotate(${(-135 + (t + 20) / 60 * 270).toFixed(1)} 100 100)`);
        const c = Number(code), word = c >= 95 ? 0 : c >= 51 ? 1 : c >= 2 ? 2 : c === 1 ? 3 : 4;
        dial.words.forEach((el, i) => el.classList.toggle("on", i === word));
    }

    function renderStatus() {
        const text = WidgetRuntime.freshness(lastUpdated, status, notBefore);
        if ($("dataStatus").textContent !== text) $("dataStatus").textContent = text;
    }

    function setting(name, fallback) {
        try {
            if (name === "weatherCity" && typeof weatherCity !== "undefined") return weatherCity || fallback;
            if (name === "weatherUnits" && typeof weatherUnits !== "undefined") return weatherUnits || fallback;
        } catch (_) {}
        return fallback;
    }

    function codeLabel(code) {
        const map = {
            0: ["Clear", "SUN"], 1: ["Mainly Clear", "SUN"], 2: ["Partly Cloudy", "CLD"], 3: ["Cloudy", "CLD"],
            45: ["Fog", "FOG"], 48: ["Fog", "FOG"], 51: ["Drizzle", "DRZ"], 61: ["Rain", "RAN"],
            63: ["Rain", "RAN"], 65: ["Heavy Rain", "RAN"], 71: ["Snow", "SNW"], 80: ["Showers", "SHW"],
            95: ["Storm", "STM"]
        };
        return map[code] || ["Weather", "WX"];
    }

    function time(value) {
        return value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "--";
    }

    function show(title, sub) {
        status = title;
        renderStatus();
        $("overlayTitle").textContent = title;
        $("overlaySub").textContent = sub;
        $("overlay").classList.add("visible");
    }

    function hide() {
        $("overlay").classList.remove("visible");
    }

    async function geocode(city, signal) {
        const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
        const data = await getJson(url, signal);
        return data.results && data.results[0];
    }

    async function weather(location, units, signal) {
        const tempUnit = units === "fahrenheit" ? "fahrenheit" : "celsius";
        const url = new URL("https://api.open-meteo.com/v1/forecast");
        url.searchParams.set("latitude", location.latitude);
        url.searchParams.set("longitude", location.longitude);
        url.searchParams.set("timezone", "auto");
        url.searchParams.set("temperature_unit", tempUnit);
        url.searchParams.set("current", "temperature_2m,weather_code,wind_speed_10m,precipitation");
        url.searchParams.set("daily", "sunrise,sunset");
        url.searchParams.set("forecast_days", "1");
        return getJson(url, signal);
    }

    async function update() {
        const city = String(setting("weatherCity", "Paris")).trim();
        const units = setting("weatherUnits", "celsius");
        const key = `${city}|${units}`;
        if (key !== activeKey) {
            activeKey = key;
            hasLiveData = false;
            lastUpdated = 0;
            // A new city must not wait out the backoff earned by the previous one.
            failures = 0;
            notBefore = 0;
            show("Loading weather", city);
        }
        if (Date.now() < notBefore) { status = "Waiting"; renderStatus(); return; }
        const seq = ++updateSeq;
        if (request) request.abort();
        request = new AbortController();
        const signal = request.signal;
        clearTimeout(retryTimer);
        if (!city) return show("City Missing", "Set a city in iCUE settings.");
        try {
            const loc = await geocode(city, signal);
            if (seq !== updateSeq) return;
            if (!loc) return show("City Not Found", city);
            if (!Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) throw new Error("invalid_location");
            const data = await weather(loc, units, signal);
            if (seq !== updateSeq) return;
            const current = data && data.current;
            if (!current || !Number.isFinite(current.temperature_2m)) throw new Error("invalid_weather");
            const [label, icon] = codeLabel(current.weather_code);
            $("place").textContent = `${loc.name}${loc.country_code ? `, ${loc.country_code}` : ""}`;
            $("condition").textContent = label;
            $("icon").textContent = icon;
            $("temp").textContent = Math.round(current.temperature_2m);
            station(current.temperature_2m, current.weather_code);
            $("unit").textContent = units === "fahrenheit" ? "°F" : "°C";
            $("wind").textContent = Number.isFinite(current.wind_speed_10m) ? `${Math.round(current.wind_speed_10m)} km/h` : "--";
            $("rain").textContent = Number.isFinite(current.precipitation) ? `${current.precipitation} mm` : "--";
            $("sunrise").textContent = time(data.daily && data.daily.sunrise && data.daily.sunrise[0]);
            $("sunset").textContent = time(data.daily && data.daily.sunset && data.daily.sunset[0]);
            failures = 0;
            hasLiveData = true;
            clearTimeout(retryTimer);
            notBefore = 0;
            lastUpdated = Date.now();
            status = "ready";
            renderStatus();
            hide();
        } catch (error) {
            if (seq !== updateSeq) return;
            failures += 1;
            notBefore = Math.max(error.retryAt || 0, Date.now() + Math.min(300000, 15000 * 2 ** Math.min(failures - 1, 5)));
            retryTimer = setTimeout(update, Math.min(2147483647, notBefore - Date.now()));
            if (hasLiveData) {
                status = error.rateLimited ? "Rate limited" : "Offline";
                renderStatus();
                hide();
            } else {
                show(error.rateLimited ? "Weather rate limited" : "Weather offline", "Retrying automatically. No current measurement available.");
            }
        }
    }

    function start() {
        if (timer) return;
        update();
        timer = setInterval(update, POLL_MS);
    }

    function refreshSettings() {
        ++updateSeq;
        if (request) request.abort();
        clearTimeout(settingsTimer);
        settingsTimer = setTimeout(update, 250);
    }

    window.WeatherNow = { start };
    window.icueEvents = { onICUEInitialized: start, onDataUpdated: refreshSettings };
    setInterval(renderStatus, 30000);
    WidgetRuntime.onResume(update);
    start();
})();
