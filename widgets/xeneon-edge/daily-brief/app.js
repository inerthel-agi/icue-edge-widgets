(() => {
    "use strict";

    const POLL_MS = 15 * 60 * 1000;
    const CLOCK_MS = 1000;
    const $ = id => document.getElementById(id);
    let pollTimer = null;
    let clockTimer = null;
    let retryTimer = null;
    let failures = 0;
    let hasLiveData = false;

    const notes = [
        "Protect the first hour.",
        "One clear priority wins the day.",
        "Move early, decide once, finish clean.",
        "Keep the plan small and visible.",
        "Check the weather, then get moving.",
        "Do the important thing before the urgent thing.",
        "Leave room for one useful surprise."
    ];

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

    function renderStatus() {
        const text = WidgetRuntime.freshness(lastUpdated, status, notBefore);
        if ($("dataStatus").textContent !== text) $("dataStatus").textContent = text;
    }

    function setting(name, fallback) {
        try {
            if (name === "briefCity" && typeof briefCity !== "undefined") return briefCity || fallback;
            if (name === "briefUnits" && typeof briefUnits !== "undefined") return briefUnits || fallback;
            if (name === "briefFormat" && typeof briefFormat !== "undefined") return briefFormat || fallback;
        } catch (_) {}
        return fallback;
    }

    function codeLabel(code) {
        const map = {
            0: ["Clear", "SUN"],
            1: ["Mainly Clear", "SUN"],
            2: ["Partly Cloudy", "CLD"],
            3: ["Cloudy", "CLD"],
            45: ["Fog", "FOG"],
            48: ["Fog", "FOG"],
            51: ["Drizzle", "DRZ"],
            61: ["Rain", "RAN"],
            63: ["Rain", "RAN"],
            65: ["Heavy Rain", "RAN"],
            71: ["Snow", "SNW"],
            80: ["Showers", "SHW"],
            95: ["Storm", "STM"]
        };
        return map[code] || ["Weather", "WX"];
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

    function dateKey(date) {
        return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    }

    function updateClock() {
        const now = new Date();
        const is12h = setting("briefFormat", "24h") === "12h";
        $("dayName").textContent = now.toLocaleDateString("en", { weekday: "long" });
        $("dateLine").textContent = now.toLocaleDateString("en", { month: "long", day: "numeric" });
        $("clock").textContent = now.toLocaleTimeString("en", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: is12h
        });
        let sum = 0;
        for (const c of dateKey(now)) sum += c.charCodeAt(0);
        $("note").textContent = notes[sum % notes.length];
    }

    function time(value) {
        if (!value) return "--";
        return new Date(value).toLocaleTimeString("en", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: setting("briefFormat", "24h") === "12h"
        });
    }

    async function geocode(city, signal) {
        const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
        const data = await getJson(url, signal);
        return data.results && data.results[0];
    }

    async function weather(location, units, signal) {
        const url = new URL("https://api.open-meteo.com/v1/forecast");
        url.searchParams.set("latitude", location.latitude);
        url.searchParams.set("longitude", location.longitude);
        url.searchParams.set("timezone", "auto");
        url.searchParams.set("temperature_unit", units === "fahrenheit" ? "fahrenheit" : "celsius");
        url.searchParams.set("current", "temperature_2m,weather_code,wind_speed_10m,precipitation");
        url.searchParams.set("daily", "sunrise,sunset");
        url.searchParams.set("forecast_days", "1");
        return getJson(url, signal);
    }

    async function updateWeather() {
        const city = String(setting("briefCity", "Paris")).trim();
        const units = setting("briefUnits", "celsius");
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
            $("weatherIcon").textContent = icon;
            $("condition").textContent = label;
            $("temp").textContent = Math.round(current.temperature_2m);
            $("unit").textContent = units === "fahrenheit" ? "°F" : "°C";
            $("sunrise").textContent = time(data.daily && data.daily.sunrise && data.daily.sunrise[0]);
            $("sunset").textContent = time(data.daily && data.daily.sunset && data.daily.sunset[0]);
            $("wind").textContent = Number.isFinite(current.wind_speed_10m) ? `${Math.round(current.wind_speed_10m)} km/h` : "--";
            $("rain").textContent = Number.isFinite(current.precipitation) ? `${current.precipitation} mm` : "--";
            failures = 0;
            hasLiveData = true;
            notBefore = 0;
            lastUpdated = Date.now();
            status = "ready";
            renderStatus();
            hide();
        } catch (error) {
            if (seq !== updateSeq) return;
            failures += 1;
            notBefore = Math.max(error.retryAt || 0, Date.now() + Math.min(300000, 15000 * 2 ** Math.min(failures - 1, 5)));
            retryTimer = setTimeout(updateWeather, Math.min(2147483647, notBefore - Date.now()));
            if (hasLiveData) {
                status = error.rateLimited ? "Rate limited" : "Offline";
                renderStatus();
                hide();
            } else {
                show(error.rateLimited ? "Weather rate limited" : "Weather offline", "Retrying automatically. No current measurement available.");
            }
        }
    }

    function update() {
        updateClock();
        updateWeather();
    }

    function start() {
        if (!clockTimer) clockTimer = setInterval(updateClock, CLOCK_MS);
        if (!pollTimer) pollTimer = setInterval(updateWeather, POLL_MS);
        update();
    }

    function refreshSettings() {
        ++updateSeq;
        if (request) request.abort();
        clearTimeout(settingsTimer);
        settingsTimer = setTimeout(update, 250);
    }

    window.DailyBrief = { start };
    window.icueEvents = { onICUEInitialized: start, onDataUpdated: refreshSettings };
    setInterval(renderStatus, 30000);
    WidgetRuntime.onResume(update);
    start();
})();
