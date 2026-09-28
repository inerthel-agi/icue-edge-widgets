/* jshint esversion: 11 */
/* global issMapStyle */
'use strict';

(function () {

    // ── Constants & Config ───────────────────────────────────────────
    const ISS_API = 'https://api.wheretheiss.at/v1/satellites/25544';

    const $ = (id) => document.getElementById(id);
    let issData = { lat: 0, lon: 0, alt: 408, vel: 7660 };
    let lastCacheWrite = 0;
    const cacheStorage = WidgetRuntime.storage('iss-cache', 'iss_cache');
    const styleStorage = WidgetRuntime.storage('iss-style', 'iss_map_style');
    let request = null, fetching = false, requestSeq = 0, notBefore = 0, failures = 0;
    let dataState = "Loading";

    function renderStatus() {
        const text = WidgetRuntime.freshness(issData.fetchedAt, dataState, notBefore);
        if ($('dataStatus').textContent !== text) $('dataStatus').textContent = text;
    }

    // ── Day / Night Calculation ──────────────────────────────────────
    // A simplified solar declination algorithm to approximate if ISS is in sunlight
    function calculateDayNight(lat, lon, date = new Date()) {
        const dayOfYear = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 1000 / 60 / 60 / 24);
        const declination = 23.45 * Math.sin(((360 / 365) * (dayOfYear - 81)) * (Math.PI / 180));

        // Equation of time (approximate in minutes)
        const B = (360 / 365) * (dayOfYear - 81) * (Math.PI / 180);
        const eqTime = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);

        // Solar time at longitude
        let tcFraction = 4 * lon + eqTime;
        let localSolarTime = date.getUTCHours() + date.getUTCMinutes() / 60 + tcFraction / 60;
        if (localSolarTime < 0) localSolarTime += 24;
        if (localSolarTime > 24) localSolarTime -= 24;

        // Hour angle
        let hourAngle = (localSolarTime - 12) * 15;

        // Calculate altitude of the sun
        const latRad = lat * (Math.PI / 180);
        const decRad = declination * (Math.PI / 180);
        const haRad = hourAngle * (Math.PI / 180);

        const sinAlt = Math.sin(latRad) * Math.sin(decRad) + Math.cos(latRad) * Math.cos(decRad) * Math.cos(haRad);
        const sunAltitude = Math.asin(sinAlt) * (180 / Math.PI);

        // ISS altitude horizon depression (in degrees). At ~400km, you can see the sun even if it's "set" on the ground.
        // Approx formula: depression = acos(EarthRadius / (EarthRadius + ISSAltitude))
        // EarthRadius ~ 6371km. acos(6371/6771) ~ 19 degrees.
        // So the ISS sees the sun if sunAltitude > -19 degrees.
        return sunAltitude > -19;
    }

    function updateSolarBadge(lat, lon) {
        const isDay = calculateDayNight(lat, lon);
        const badge = $('solarBadge');
        if (isDay) {
            badge.className = 'solar-badge is-day';
            $('solarIcon').textContent = '☀️';
            $('solarText').textContent = 'SUNLIGHT';
        } else {
            badge.className = 'solar-badge is-night';
            $('solarIcon').textContent = '🌙';
            $('solarText').textContent = 'ECLIPSE';
        }
    }


    // ── Telemetry & API ──────────────────────────────────────────────
    function updateTelemetry(vel, alt, lat, lon) {
        $('valSpeed').textContent = Math.round(vel * 1000 / 3600) + ' m/s';
        $('valAlt').textContent = Math.round(alt) + ' km';
        $('valLat').textContent = (lat >= 0 ? lat.toFixed(2) + '°N' : Math.abs(lat).toFixed(2) + '°S');
        $('valLon').textContent = (lon >= 0 ? lon.toFixed(2) + '°E' : Math.abs(lon).toFixed(2) + '°W');

        updateSolarBadge(lat, lon);
    }

    async function fetchISS() {
        if (fetching || Date.now() < notBefore) return;
        fetching = true;
        const seq = ++requestSeq;
        request = new AbortController();
        try {
            const { data: d } = await WidgetRuntime.requestJson(ISS_API, { signal: request.signal });
            if (seq !== requestSeq) return;
            if (![d.latitude, d.longitude, d.altitude, d.velocity].every(Number.isFinite) ||
                Math.abs(d.latitude) > 90 || Math.abs(d.longitude) > 180) throw new Error('invalid_iss');
            issData = { lat: d.latitude, lon: d.longitude, alt: d.altitude, vel: d.velocity, fetchedAt: Date.now() };
            // Polled every 2 s: the cache only needs a fresh position once a minute.
            if (issData.fetchedAt - lastCacheWrite > 60000) { cacheStorage.write(issData); lastCacheWrite = issData.fetchedAt; }
            updateTelemetry(d.velocity, d.altitude, d.latitude, d.longitude);
            updateLeafletMap(d.latitude, d.longitude);
            failures = 0;
            notBefore = 0;
            dataState = "ready";
            renderStatus();
        } catch (error) {
            if (seq !== requestSeq) return;
            failures++;
            notBefore = Math.max(error.retryAt || 0, Date.now() + Math.min(60000, 2000 * 2 ** Math.min(failures, 5)));
            dataState = error.rateLimited ? 'Rate limited' : 'Offline';
            renderStatus();
            $('solarText').textContent = 'OFFLINE';
            $('solarBadge').className = 'solar-badge';
            $('solarBadge').title = issData.fetchedAt ? `Last position: ${new Date(issData.fetchedAt).toLocaleString('en')}` : 'No current position available';
        } finally {
            if (seq === requestSeq) fetching = false;
        }
    }

    WidgetRuntime.onResume(() => {
        ++requestSeq;
        if (request) request.abort();
        fetching = false;
        fetchISS();
        if (mapTileLayer && mapTilesFailed) {
            mapTilesFailed = false;
            $('mapStatus').textContent = 'Loading map';
            mapTileLayer.redraw();
        }
    });
    fetchISS();
    setInterval(fetchISS, 2000);


    // ── Orbital Ground Track (Math) ──────────────────────────────────
    const INCLINATION = 51.6;
    const ORBITAL_PERIOD = 92.68 * 60;
    const EARTH_ROT_RATE = 360 / 86400;
    const GROUND_TRACK_RATE = 360 / ORBITAL_PERIOD - EARTH_ROT_RATE;
    const ORBIT_RANGE = ORBITAL_PERIOD * 6;
    const ORBIT_STEP = 60;

    let prevLat = null;
    let isAscending = true;

    function computeOrbitTrack(lat, lon, ascending) {
        const inc = INCLINATION;
        const clampedLat = Math.max(-inc, Math.min(inc, lat));
        let phase0 = Math.asin(clampedLat / inc);
        if (!ascending) phase0 = Math.PI - phase0;

        const pastPts = [], futurePts = [];

        for (let dt = -ORBIT_RANGE; dt <= 0; dt += ORBIT_STEP) {
            const phase = phase0 + (2 * Math.PI / ORBITAL_PERIOD) * dt;
            const newLat = inc * Math.sin(phase);
            const newLon = lon + GROUND_TRACK_RATE * dt;
            pastPts.push([newLat, newLon]);
        }
        for (let dt = 0; dt <= ORBIT_RANGE; dt += ORBIT_STEP) {
            const phase = phase0 + (2 * Math.PI / ORBITAL_PERIOD) * dt;
            const newLat = inc * Math.sin(phase);
            const newLon = lon + GROUND_TRACK_RATE * dt;
            futurePts.push([newLat, newLon]);
        }
        return { pastPts, futurePts };
    }

    function createPassMessage(title, text) {
        const container = document.createElement('div');
        container.setAttribute('role', 'status');
        const heading = document.createElement('div');
        heading.className = 'pass-popup-title';
        heading.textContent = title;
        const detail = document.createElement('div');
        detail.className = 'pass-popup-detail';
        detail.textContent = text;
        container.append(heading, detail);
        return container;
    }

    function createNextPassPopup(timeStr, dateStr, relStr, distKm) {
        const safeDist = Number.isFinite(distKm) ? Math.max(0, Math.round(distKm)) : 0;
        const container = document.createElement('div');

        const title = document.createElement('div');
        title.className = 'pass-popup-title';
        title.textContent = 'Estimated next pass';

        const time = document.createElement('div');
        time.className = 'pass-popup-time';
        time.textContent = String(timeStr || '--:--');

        const eta = document.createElement('div');
        eta.className = 'pass-popup-detail';
        eta.textContent = `${String(dateStr || '')} - in ~${String(relStr || '0min')}`;

        const distance = document.createElement('div');
        distance.className = 'pass-popup-detail';
        distance.textContent = `Closest approach: ~${safeDist} km`;

        const note = document.createElement('div');
        note.className = 'pass-popup-detail';
        note.textContent = 'Approximate ground track; not a visibility forecast.';
        container.setAttribute('role', 'status');
        container.append(title, time, eta, distance, note);
        return container;
    }


    // ── Leaflet Map Setup ────────────────────────────────────────────
    const MAP_STYLES = {
        dark: {
            url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            options: { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors' }
        },
        satellite: {
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            options: { maxZoom: 18, attribution: 'Tiles &copy; Esri' },
            labels: {
                url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
                options: { maxZoom: 18, pane: 'labelsPane' }
            }
        },
        day: {
            url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            options: { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors' }
        }
    };
    let leafletMap = null, issMapMarker = null, mapTileLayer = null, mapLabelLayer = null;
    let pastPolylines = [], futurePolylines = [];
    let mapFollowISS = true;
    let currentMapStyle = 'dark';
    let appliedMapStyle = null;
    let mapTilesFailed = false;
    currentMapStyle = normalizeMapStyle(styleStorage.read() || 'dark');

    function resolvedMapStyle() {
        if (currentMapStyle !== 'auto') return currentMapStyle;
        return calculateDayNight(issData.lat, issData.lon) ? 'day' : 'dark';
    }

    function normalizeMapStyle(value) {
        const style = String(value || '').trim().toLowerCase();
        if (style === 'sat' || style === 'satellite') return 'satellite';
        return (MAP_STYLES[style] || style === 'auto') ? style : 'dark';
    }

    function readIcueMapStyle() {
        if (typeof issMapStyle !== 'undefined') {
            return normalizeMapStyle(issMapStyle);
        }
        if (typeof window !== 'undefined' && Object.prototype.hasOwnProperty.call(window, 'issMapStyle')) {
            return normalizeMapStyle(window.issMapStyle);
        }
        return null;
    }

    function setMapNightOverlay() {
        const night = resolvedMapStyle() === 'dark' && currentMapStyle === 'auto' && !calculateDayNight(issData.lat, issData.lon);
        document.body.classList.toggle('map-night', night);
    }

    function applyMapStyle(style) {
        const nextStyle = normalizeMapStyle(style);
        if (currentMapStyle !== nextStyle) styleStorage.write(nextStyle);
        currentMapStyle = nextStyle;
        if (!leafletMap) return;
        const resolvedStyleName = resolvedMapStyle();
        document.body.dataset.mapStyle = resolvedStyleName;
        if (appliedMapStyle === resolvedStyleName) {
            setMapNightOverlay();
            return;
        }
        if (mapTileLayer) leafletMap.removeLayer(mapTileLayer);
        if (mapLabelLayer) leafletMap.removeLayer(mapLabelLayer);
        const resolved = MAP_STYLES[resolvedStyleName] || MAP_STYLES.dark;
        mapTileLayer = L.tileLayer(resolved.url, resolved.options).addTo(leafletMap);
        const layer = mapTileLayer;
        mapTilesFailed = false;
        $('mapStatus').textContent = 'Ground Track';
        layer.on('tileerror', () => {
            if (layer !== mapTileLayer) return;
            mapTilesFailed = true;
            $('mapStatus').textContent = 'Map tiles unavailable';
        });
        layer.on('load', () => {
            if (layer === mapTileLayer && !mapTilesFailed) $('mapStatus').textContent = 'Ground Track';
        });
        mapLabelLayer = resolved.labels ? L.tileLayer(resolved.labels.url, resolved.labels.options).addTo(leafletMap) : null;
        appliedMapStyle = resolvedStyleName;
        setMapNightOverlay();
    }

    function syncIcueMapStyle() {
        const nativeMapStyle = readIcueMapStyle();
        if (nativeMapStyle && nativeMapStyle !== currentMapStyle) applyMapStyle(nativeMapStyle);
    }

    window.IssHorizonIcue = {
        syncMapStyle: syncIcueMapStyle
    };

    function initLeafletMap() {
        if (typeof L === 'undefined') {
            $('mapStatus').textContent = 'Map library unavailable';
            $('btnPass').disabled = true;
            $('btnFollow').disabled = true;
            return;
        }

        leafletMap = L.map('issMap', {
            zoomControl: false,
            attributionControl: true,
            dragging: true,
            scrollWheelZoom: true,
            doubleClickZoom: true,
            minZoom: 2,
            maxZoom: 15,
            maxBounds: [[-85, -9999], [85, 9999]],
            maxBoundsViscosity: 1.0,
        }).setView([20, 0], 2);
        leafletMap.createPane('labelsPane');
        leafletMap.getPane('labelsPane').style.zIndex = 420;
        leafletMap.getPane('labelsPane').style.pointerEvents = 'none';

        applyMapStyle(currentMapStyle);

        const issIcon = L.divIcon({
            className: 'iss-map-marker',
            html: '<div class="iss-dot"></div>',
            iconSize: [14, 14],
            iconAnchor: [7, 7],
        });
        issMapMarker = L.marker([0, 0], { icon: issIcon, zIndexOffset: 1000 }).addTo(leafletMap);

        leafletMap.on('dragstart', () => setFollowMode(false));
        leafletMap.getContainer().addEventListener('keydown', event => {
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) setFollowMode(false);
        }, true);
        leafletMap.on('click', event => showPassAt(event.latlng));
        leafletMap.on('contextmenu', event => showPassAt(event.latlng));

        setTimeout(() => leafletMap.invalidateSize(), 200);
    }

    function showPassAt(location) {
        if (!leafletMap) return;
        setFollowMode(false);
        let content;
        if (!Number.isFinite(issData.fetchedAt) || Math.abs(Date.now() - issData.fetchedAt) > 30000) {
            content = createPassMessage('Position unavailable', 'Wait for a current ISS position before estimating a pass.');
        } else {
            const result = predictNextPass(location.lat, location.lng);
            if (!result) content = createPassMessage('No nearby pass found', 'No ground-track approach within 500 km was found in the next three days of this simplified model.');
            else {
                const date = new Date(Date.now() + result.dt * 1000);
                const hours = Math.floor(result.dt / 3600);
                const minutes = Math.floor(result.dt % 3600 / 60);
                content = createNextPassPopup(
                    date.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false }),
                    date.toLocaleDateString('en', { month: 'short', day: 'numeric' }),
                    `${hours ? hours + 'h ' : ''}${minutes}min`, result.dist);
            }
        }
        const bounds = leafletMap.getContainer();
        L.popup({
            maxWidth: Math.max(120, Math.min(320, bounds.clientWidth - 80)),
            maxHeight: Math.max(48, bounds.clientHeight - 64)
        }).setLatLng(location).setContent(content).openOn(leafletMap);
    }

    // ── ISS Pass Prediction Algorithm ────────────────────────────────
    // Iterates forward in time using the same simplified orbital model
    // to find the next closest approach of the ISS ground track to a point.
    function predictNextPass(targetLat, targetLon) {
        if (!issData || isNaN(issData.lat)) return null;

        const currentLat = issData.lat;
        const currentLon = issData.lon;
        const inc = INCLINATION;
        const clampedLat = Math.max(-inc, Math.min(inc, currentLat));

        let phase0 = Math.asin(clampedLat / inc);
        if (!isAscending) phase0 = Math.PI - phase0;

        // ponytail: simplified three-day ground track; use orbital elements/SGP4 for precise passes.
        const SEARCH_RANGE = 3 * 86400;
        const COARSE_STEP = 30;                    // 30s coarse scan
        const FINE_STEP = 2;                       // 2s fine scan


        // Earth radius in km
        const R = 6371;

        function haversine(lat1, lon1, lat2, lon2) {
            const toRad = (d) => d * Math.PI / 180;
            const dLat = toRad(lat2 - lat1);
            const dLon = toRad(lon2 - lon1);
            const a = Math.sin(dLat / 2) ** 2 +
                Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
            return 2 * R * Math.asin(Math.sqrt(Math.min(1, a)));
        }

        function issPositionAt(dt) {
            const phase = phase0 + (2 * Math.PI / ORBITAL_PERIOD) * dt;
            const lat = inc * Math.sin(phase);
            let lon = currentLon + GROUND_TRACK_RATE * dt;
            // Wrap to [-180, 180]
            lon = ((lon + 180) % 360 + 360) % 360 - 180;
            return { lat, lon };
        }

        const PASS_THRESHOLD = 500;
        function distanceAt(dt) {
            const pos = issPositionAt(dt);
            return haversine(targetLat, targetLon, pos.lat, pos.lon);
        }
        let left = distanceAt(0), middle = distanceAt(COARSE_STEP);
        if (left < PASS_THRESHOLD && left <= middle) return { dt: 0, dist: left };
        for (let dt = COARSE_STEP * 2; dt <= SEARCH_RANGE; dt += COARSE_STEP) {
            const right = distanceAt(dt);
            if (middle <= left && middle < right && middle < PASS_THRESHOLD) {
                let best = { dt: dt - COARSE_STEP, dist: middle };
                for (let fine = dt - 2 * COARSE_STEP; fine <= dt; fine += FINE_STEP) {
                    const dist = distanceAt(fine);
                    if (dist < best.dist) best = { dt: fine, dist };
                }
                return best;
            }
            left = middle;
            middle = right;
        }
        return null;
    }

    function syncPolylines(pool, segments, style) {
        segments.forEach((seg, i) => {
            if (pool[i]) pool[i].setLatLngs(seg);
            else pool[i] = L.polyline(seg, style).addTo(leafletMap);
        });
        for (let i = segments.length; i < pool.length; i++) {
            leafletMap.removeLayer(pool[i]);
        }
        pool.length = segments.length;
    }

    function updateLeafletMap(lat, lon) {
        if (!issMapMarker) return;
        syncIcueMapStyle();
        issMapMarker.setLatLng([lat, lon]);
        if (currentMapStyle === 'auto') applyMapStyle('auto');
        else setMapNightOverlay();

        if (prevLat !== null) {
            isAscending = lat > prevLat;
        }
        prevLat = lat;

        const { pastPts, futurePts } = computeOrbitTrack(lat, lon, isAscending);

        syncPolylines(pastPolylines, [pastPts], {
            color: '#5f6368',           // Muted grey for past
            weight: 2,
            opacity: 0.6,
            className: 'orbit-past-line',
        });

        syncPolylines(futurePolylines, [futurePts], {
            color: '#fc3d21',           // NASA Orange for future
            weight: 2,
            opacity: 0.8,
            dashArray: '6, 6',
            className: 'orbit-future-line',
        });

        if (mapFollowISS && leafletMap) {
            leafletMap.setView([lat, lon], leafletMap.getZoom(), { animate: true, duration: 0.8 });
        }
    }

    function setFollowMode(enabled) {
        mapFollowISS = enabled;
        $('btnFollow').classList.toggle('active', enabled);
        $('btnFollow').setAttribute('aria-pressed', String(enabled));
        if (leafletMap) {
            leafletMap.dragging.enable();
            if (enabled) {
                leafletMap.setView([issData.lat, issData.lon], leafletMap.getZoom(), { animate: true });
            }
        }
    }

    $('btnFollow').addEventListener('click', () => {
        setFollowMode(!mapFollowISS);
    });

    $('btnPass').addEventListener('click', () => { if (leafletMap) showPassAt(leafletMap.getCenter()); });
    initLeafletMap();
    syncIcueMapStyle();
    setInterval(syncIcueMapStyle, 1000);

    // Instant render from cache
    try {
        const cached = cacheStorage.read();
        if (cached) {
            const lat = Number(cached.lat);
            const lon = Number(cached.lon);
            const alt = Number(cached.alt);
            const vel = Number(cached.vel);
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
                issData = {
                    lat,
                    lon,
                    alt: Number.isFinite(alt) ? alt : issData.alt,
                    vel: Number.isFinite(vel) ? vel : issData.vel,
                    fetchedAt: Number(cached.fetchedAt) || 0
                };
                updateTelemetry(issData.vel, issData.alt, issData.lat, issData.lon);
                updateLeafletMap(issData.lat, issData.lon);
                dataState = 'Cached';
                renderStatus();
                $('solarText').textContent = 'CACHED';
                $('solarBadge').title = issData.fetchedAt ? `Last position: ${new Date(issData.fetchedAt).toLocaleString('en')}` : 'Cached position; timestamp unavailable';
            }
        }
    } catch (_) { }
    setInterval(renderStatus, 15000);
    renderStatus();
})();
