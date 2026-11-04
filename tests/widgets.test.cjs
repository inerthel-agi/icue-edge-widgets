const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

process.env.TZ = 'Europe/Paris';

const root = path.join(__dirname, '..');
/** Source folder of a widget: widgets/pump/<name> for pump screens, widgets/xeneon-edge/<name> otherwise. */
const widgetDir = name => path.join(root, 'widgets', name.endsWith('-pump') ? 'pump' : 'xeneon-edge', name);

function runtime(widget, globals = {}, storage = new Map()) {
    let now = Date.parse('2026-10-24T12:00:00Z');
    let writes = 0;
    const nodes = new Map(), intervals = [], frames = [], timeouts = new Map();
    let timerId = 0;
    const events = {};
    function element() {
        return {
            textContent: '', innerHTML: '', dataset: {}, children: [], attributes: {},
            style: { setProperty(name, value) { this[name] = value; } },
            classList: (() => {
                const set = new Set();
                return {
                    add: (...c) => c.forEach((x) => set.add(x)), remove: (...c) => c.forEach((x) => set.delete(x)), contains: (c) => set.has(c),
                    toggle: (c, on) => { const v = on === undefined ? !set.has(c) : !!on; if (v) set.add(c); else set.delete(c); return v; }
                };
            })(),
            get childElementCount() { return this.children.length; },
            appendChild(child) { this.children.push(child); },
            append(...kids) { this.children.push(...kids); },
            replaceChildren(...kids) { this.children = kids; },
            setAttribute(key, value) { this.attributes[key] = value; },
            removeAttribute(key) { delete this.attributes[key]; },
            remove() {},
            toggleAttribute(key, on) { if (on) this.attributes[key] = ''; else delete this.attributes[key]; },
            addEventListener(name, fn) { this[name] = fn; }
        };
    }
    const get = id => {
        if (!nodes.has(id)) nodes.set(id, element());
        return nodes.get(id);
    };
    class Clock extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    }
    const context = {
        Date: Clock, URL, Intl, console, AbortController, TextDecoder,
        addEventListener: (name, fn) => { events[name] = fn; },
        document: { getElementById: get, createElement: element, body: element(), documentElement: element(), addEventListener: (name, fn) => { events[name] = fn; } },
        location: { search: '' },
        localStorage: {
            getItem: key => storage.get(key) || null,
            setItem: (key, value) => { storage.set(key, value); writes++; }
        },
        setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
        clearInterval() {},
        setTimeout: (fn, ms) => { const id = ++timerId; timeouts.set(id, { fn, ms }); return id; },
        clearTimeout: id => timeouts.delete(id),
        requestAnimationFrame: fn => { frames[0] = fn; return 1; },
        ...globals
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(root, 'shared', 'widget-runtime.js'), 'utf8'), context);
    vm.runInContext(fs.readFileSync(path.join(widgetDir(widget), 'app.js'), 'utf8'), context);
    return {
        context, get, storage, events, timeouts, writes: () => writes,
        runTimeout: ms => { for (const [id, timer] of [...timeouts]) if (timer.ms === ms) { timeouts.delete(id); timer.fn(); } },
        at: value => { now = typeof value === 'number' ? value : Date.parse(value); },
        now: () => now,
        tick: () => { if (frames[0]) frames[0](); else intervals[0].fn(); },
        runInterval: ms => { for (const timer of intervals.filter(i => i.ms === ms)) timer.fn(); }
    };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const response = (data, status = 200, link = '') => {
    const body = new TextEncoder().encode(JSON.stringify(data));
    let sent = false;
    return {
        ok: status >= 200 && status < 300, status,
        headers: { get: name => name.toLowerCase() === 'link' ? link : name.toLowerCase() === 'content-length' ? String(body.byteLength) : null },
        body: { getReader: () => ({ read: async () => sent ? { done: true } : (sent = true, { value: body, done: false }) }) }
    };
};

test('focus reload keeps remaining time instead of subtracting elapsed time twice', () => {
    const first = runtime('focus-timer');
    first.tick(); first.get('btnStart').click();
    first.at(first.now() + 300000); first.tick();
    assert.equal(first.get('time').textContent, '20:00');
    const second = runtime('focus-timer', {}, first.storage);
    second.at(first.now()); second.tick();
    assert.equal(second.get('time').textContent, '20:00');
});

test('paused focus timer does not write storage on each redraw', () => {
    const app = runtime('focus-timer'); app.tick();
    const before = app.writes();
    for (let i = 0; i < 60; i++) app.tick();
    assert.equal(app.writes(), before);
});

test('focus carries time over a completed work period', () => {
    const app = runtime('focus-timer'); app.tick(); app.get('btnStart').click();
    app.at(app.now() + 26 * 60000); app.tick();
    assert.equal(app.get('time').textContent, '04:00');
    assert.equal(app.get('modeBadge').textContent, 'Break');
});

test('legacy focus snapshots resume their last saved remaining duration', () => {
    const storage = new Map([['xeneonFocusState', JSON.stringify({
        mode: 'work', cycle: 1, running: true, remaining: 1200000, startedAt: 1
    })]]);
    const app = runtime('focus-timer', {}, storage); app.tick();
    assert.equal(app.get('time').textContent, '20:00');
});

test('focus pause survives reload without consuming paused time', () => {
    const app = runtime('focus-timer'); app.get('btnStart').click();
    app.at(app.now() + 300000); app.get('btnStart').click();
    const reloaded = runtime('focus-timer', {}, app.storage);
    reloaded.at(app.now() + 3600000); reloaded.tick();
    assert.equal(reloaded.get('time').textContent, '20:00');
    assert.equal(reloaded.get('btnStart').textContent, 'Start');
});

test('focus catches up over many complete cycles without discarding the remainder', () => {
    const app = runtime('focus-timer'); app.get('btnStart').click();
    app.at(app.now() + (130 * 10000 + 26) * 60000); app.tick();
    assert.equal(app.get('time').textContent, '04:00');
    assert.equal(app.get('modeBadge').textContent, 'Break');
});

test('countdowns reject impossible dates and accept leap days', () => {
    const bad = runtime('countdowns', { countdown1Date: '2026-02-31' });
    assert.equal(bad.get('nextDate').textContent, '');
    assert.ok(bad.get('overlay').classList.contains('visible'), 'an impossible date shows the overlay');
    const good = runtime('countdowns', { countdown1Date: '2028-02-29' });
    assert.match(good.get('nextDate').textContent, /Feb 29/);
});

test('countdowns count calendar days across the autumn clock change', () => {
    const app = runtime('countdowns', { countdown1Date: '2026-10-26' });
    assert.equal(app.get('nextDays').textContent, '2');
});

for (const widget of ['weather-now', 'daily-brief']) {
    for (const [name, payload, status] of [
        ['HTTP error', { error: true }, 429],
        ['missing current measurement', {}, 200],
        ['null temperature', { current: { temperature_2m: null } }, 200]
    ]) {
        test(`${widget} does not invent a temperature on ${name}`, async () => {
            const app = runtime(widget, { fetch: async url => String(url).includes('geocoding')
                ? response({ results: [{ name: 'Paris', latitude: 48, longitude: 2 }] })
                : response(payload, status) });
            await flush();
            assert.equal(app.get('temp').textContent, '');
            // The failure is shown as such, not left on the initial loading screen.
            assert.notEqual(app.get('overlayTitle').textContent, 'Loading weather');
            assert.ok(app.get('overlay').classList.contains('visible'));
        });
    }
    test(`${widget} preserves a real zero temperature`, async () => {
        const app = runtime(widget, { fetch: async url => String(url).includes('geocoding')
            ? response({ results: [{ name: 'Paris', latitude: 48, longitude: 2 }] })
            : response({ current: { temperature_2m: 0, weather_code: 0 } }) });
        await flush();
        assert.equal(Number(app.get('temp').textContent), 0);
        assert.equal(app.get('condition').textContent, 'Clear');
    });
    test(`${widget} ignores an older response after the city changes`, async () => {
        let resolveOld;
        const app = runtime(widget, { fetch: async url => {
            const u = new URL(url);
            if (u.hostname.startsWith('geocoding')) return response({ results: [{
                name: u.searchParams.get('name'), latitude: u.searchParams.get('name') === 'Paris' ? 48 : 35, longitude: 2
            }] });
            if (u.searchParams.get('latitude') === '48') return new Promise(resolve => { resolveOld = resolve; });
            return response({ current: { temperature_2m: 30, weather_code: 0 } });
        } });
        await flush();
        app.context[widget === 'weather-now' ? 'weatherCity' : 'briefCity'] = 'Tokyo';
        app.context.icueEvents.onDataUpdated(); app.runTimeout(250); await flush();
        resolveOld(response({ current: { temperature_2m: 10, weather_code: 0 } })); await flush();
        assert.equal(app.get('place').textContent, 'Tokyo');
        assert.equal(Number(app.get('temp').textContent), 30);
    });
}

test('GitHub counts issues and pulls beyond the first page', async () => {
    const app = runtime('github-repo-monitor', { fetch: async url => {
        const u = new URL(url);
        if (u.pathname.endsWith('/issues')) {
            return u.searchParams.get('page') === '2'
                ? response(Array.from({ length: 23 }, () => ({})))
                : response(Array.from({ length: 100 }, () => ({ pull_request: {} })), 200, '<next>; rel="next"');
        }
        if (u.pathname.endsWith('/pulls')) return response(Array.from({ length: 100 }, () => ({})));
        if (u.pathname.endsWith('/commits')) return response([{ sha: 'abcdef0', commit: { message: 'Example' } }]);
        return response({ default_branch: 'main', stargazers_count: 7 });
    } });
    await flush();
    assert.equal(app.get('issues').textContent, '23');
    assert.equal(app.get('prs').textContent, '100');
});

test('GitHub explicitly labels bounded counts instead of presenting a false total', async () => {
    let pages = 0;
    const app = runtime('github-repo-monitor', { fetch: async url => {
        const u = new URL(url);
        if (u.pathname.endsWith('/issues')) {
            pages++;
            return response(Array.from({ length: 100 }, () => ({})), 200, '<next>; rel="next"');
        }
        if (u.pathname.endsWith('/commits')) return response([]);
        return response({ default_branch: 'main' });
    } });
    await flush();
    assert.equal(pages, 10);
    assert.equal(app.get('issues').textContent, '≥1,000');
    assert.match(app.get('issues').title, /At least/);
});

test('instance storage isolates timers and preserves legacy and unrelated data', () => {
    const legacy = JSON.stringify({ mode: 'work', cycle: 1, running: false, remaining: 600000, startedAt: 0 });
    const storage = new Map([['xeneonFocusState', legacy], ['instance-a', '{"other-widget":42}']]);
    const a = runtime('focus-timer', { uniqueId: 'instance-a' }, storage);
    const b = runtime('focus-timer', { uniqueId: 'instance-b' }, storage);
    a.get('btnReset').click();
    assert.equal(JSON.parse(storage.get('instance-a'))['focus-timer'].remaining, 1500000);
    assert.equal(JSON.parse(storage.get('instance-b'))['focus-timer'].remaining, 600000);
    assert.equal(JSON.parse(storage.get('instance-a'))['other-widget'], 42);
    assert.equal(storage.get('xeneonFocusState'), legacy);
    assert.equal(b.get('time').textContent, '10:00');
});

test('malformed instance storage is preserved instead of overwritten', () => {
    const storage = new Map([['instance-a', '{invalid']]);
    const app = runtime('focus-timer', { uniqueId: 'instance-a' }, storage);
    app.get('btnStart').click();
    assert.equal(storage.get('instance-a'), '{invalid');
});

test('requests time out and release their timer', async () => {
    const app = runtime('countdowns', { fetch: (url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
    }) });
    const result = app.context.WidgetRuntime.requestJson('https://example.test/data');
    app.runTimeout(12000);
    await assert.rejects(result, /aborted/);
    assert.equal([...app.timeouts.values()].filter(t => t.ms === 12000).length, 0);
});

test('an external abort cancels the actual fetch', async () => {
    let fetchSignal;
    const app = runtime('countdowns', { fetch: (url, { signal }) => new Promise((resolve, reject) => {
        fetchSignal = signal;
        signal.addEventListener('abort', () => reject(new Error('cancelled')));
    }) });
    const controller = new AbortController();
    const result = app.context.WidgetRuntime.requestJson('https://example.test/data', { signal: controller.signal });
    controller.abort();
    await assert.rejects(result, /cancelled/);
    assert.equal(fetchSignal.aborted, true);
});

test('oversized JSON is rejected before it is buffered', async () => {
    let aborted = false;
    const app = runtime('countdowns', { fetch: async (url, { signal }) => {
        signal.addEventListener('abort', () => { aborted = true; });
        return {
            ok: true, status: 200,
            headers: { get: name => name.toLowerCase() === 'content-length' ? String(2 * 1024 * 1024 + 1) : null },
            body: { getReader: () => ({ read: async () => { throw new Error('body should not be read'); } }) }
        };
    } });
    await assert.rejects(app.context.WidgetRuntime.requestJson('https://example.test/large'), /response_too_large/);
    assert.equal(aborted, true);
});

test('media widgets cancel replaced artwork downloads before starting another', () => {
    for (const [widget, file] of [['now-playing', 'widget.js'], ['spotify', 'widget.js'], ['windows-media-pump', 'app.js']]) {
        const source = fs.readFileSync(path.join(widgetDir(widget), file), 'utf8');
        assert.match(source, /entry\.controller\.abort\(\)/, file);
        assert.match(source, /signal:\s*entry\.controller\.signal/, file);
        assert.match(source, /content-length/, file);
    }
});

test('GitHub respects Retry-After across settings and resume events', async () => {
    let requests = 0;
    const app = runtime('github-repo-monitor', { fetch: async () => {
        requests++;
        return { ...response({}, 429), headers: { get: name => name === 'retry-after' ? '90' : null } };
    } });
    await flush();
    const before = requests;
    app.events.online();
    app.context.icueEvents.onDataUpdated(); app.runTimeout(250); await flush();
    assert.equal(requests, before);
    assert.equal(app.get('overlayTitle').textContent, 'Rate limited');
    app.at(app.now() + 90001); app.events.online(); await flush();
    assert.ok(requests > before);
});

test('GitHub distinguishes denied access from rate limiting', async () => {
    const app = runtime('github-repo-monitor', { fetch: async () => response({}, 403) });
    await flush();
    assert.equal(app.get('overlayTitle').textContent, 'Access denied');
});

test('weather settings debounce requests and cancel obsolete work', async () => {
    const signals = [];
    const app = runtime('weather-now', { fetch: (url, { signal }) => {
        signals.push(signal);
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    } });
    for (let i = 0; i < 5; i++) app.context.icueEvents.onDataUpdated();
    assert.equal(signals[0].aborted, true);
    assert.equal(signals.length, 1);
    app.runTimeout(250); await flush();
    assert.equal(signals.length, 2);
});

function signal() {
    const callbacks = new Set();
    return { connect: fn => callbacks.add(fn), disconnect: fn => callbacks.delete(fn), emit: (...args) => { for (const fn of callbacks) fn(...args); } };
}

function sensorPlugin(rows) {
    const plugin = { asyncResponse: signal(), sensorValueChanged: signal(), sensorRemoved: signal(), sensorAdded: signal(), sensorUnitsChanged: signal() };
    const reply = (id, value) => queueMicrotask(() => plugin.asyncResponse.emit(id, value));
    plugin.getAllSensorIds = id => reply(id, Object.keys(rows));
    plugin.sensorIsConnected = (id, sensor) => reply(id, !!rows[sensor]);
    for (const [method, field] of Object.entries({ getSensorName: 'name', getSensorDeviceName: 'device', getSensorType: 'type', getSensorKind: 'kind', getSensorUnits: 'units', getSensorValue: 'value' })) {
        plugin[method] = (id, sensor) => reply(id, rows[sensor]?.[field] || '');
    }
    return plugin;
}

test('sensors reconnect, remove vanished readings, and convert Fahrenheit warning thresholds', async () => {
    const rows = { cpu: { name: 'CPU temperature', device: 'CPU', type: 'temperature', units: 'C', value: '80' } };
    const plugin = sensorPlugin(rows);
    const app = runtime('cooling-sensor-pump', { plugins: { Sensorsdataprovider: plugin }, pluginSensorsdataprovider_initialized: true });
    await flush();
    assert.equal(app.get('ring').style['--accent'], '#ff4d4d');
    rows.cpu.units = 'F'; rows.cpu.value = '122';
    plugin.sensorUnitsChanged.emit('cpu'); await flush();
    assert.equal(app.get('units').textContent, 'F');
    assert.equal(app.get('ring').style['--accent'], '#1db954');
    delete rows.cpu; plugin.sensorRemoved.emit('cpu'); await flush();
    assert.equal(app.get('value').textContent, '--');
    assert.equal(app.get('widget').dataset.state, 'empty');
    app.context.plugins.Sensorsdataprovider = sensorPlugin({ pump: { name: 'CPU pump', type: 'rpm', units: 'RPM', value: '2400' } });
    await app.context.CoolingSensorPump.update();
    assert.equal(app.get('value').textContent, '2400');
    assert.equal(app.get('units').textContent, 'RPM');
});

test('a failed sensor request becomes an offline state instead of an unhandled rejection', async () => {
    const plugin = sensorPlugin({});
    plugin.getAllSensorIds = () => { throw new Error('disconnected'); };
    const app = runtime('cooling-sensor-pump', { plugins: { Sensorsdataprovider: plugin }, pluginSensorsdataprovider_initialized: true });
    await flush();
    assert.equal(app.get('widget').dataset.state, 'offline');
    assert.equal(app.get('value').textContent, '--');
});

test('media provider replacement cancels pending old responses and connects the new provider', async () => {
    const old = { asyncResponse: signal(), getSongName() {}, getArtist() {} };
    const app = runtime('windows-media-pump', {
        plugins: { Mediadataprovider: old }, location: { search: '' }, URLSearchParams,
        fetch: () => Promise.reject(new Error('companion offline'))
    });
    await flush();
    app.at(app.now() + 9000);
    app.tick(); // companion down for over 8 s: native mode asks the old provider
    const next = { asyncResponse: signal() };
    next.getSongName = id => queueMicrotask(() => next.asyncResponse.emit(id, 'New track'));
    next.getArtist = id => queueMicrotask(() => next.asyncResponse.emit(id, 'New artist'));
    app.context.plugins.Mediadataprovider = next;
    app.runInterval(1500);
    await flush();
    old.asyncResponse.emit(1, 'Stale track'); await flush();
    assert.equal(app.get('title').textContent, 'New track');
    assert.equal(app.get('artist').textContent, 'New artist');
    assert.equal(app.get('chipText').textContent, 'Native mode');
    assert.equal([...app.timeouts.values()].filter(t => t.ms === 900).length, 0);
});

test('pump relay file feeds the widget when the companion socket is unreachable, and expires', async () => {
    const app = runtime('windows-media-pump', { location: { search: '' }, URLSearchParams, fetch: () => Promise.reject(new Error('blocked')) });
    await flush();
    app.context.pumpRelay({
        schema: 'media/1', v: 1, source: { kind: 'companion', connected: true, instance: 'a', lastSeen: app.now() },
        session: { id: 'm1', rev: 3, app: { name: 'Spotify' }, title: 'Psycho', artist: 'Red Velvet', playback: 'playing', timeline: null, art: null }
    });
    assert.equal(app.get('title').textContent, 'Psycho');
    assert.equal(app.get('chipText').textContent, 'Spotify · Playing');
    app.at(app.now() + 9000);
    app.tick(); // the companion stopped rewriting the file
    assert.equal(app.get('widget').dataset.view, 'empty');
});

test('freshness distinguishes missing, current, old and retrying data', () => {
    const app = runtime('countdowns');
    const format = app.context.WidgetRuntime.freshness;
    assert.equal(format(0, 'Loading'), 'Loading · No data yet');
    assert.equal(format(app.now()), 'Updated just now');
    assert.equal(format(app.now() - 300000), 'Updated 5 min ago');
    assert.equal(format(app.now() - 2 * 86400000, 'Offline'), 'Offline · Updated 2 d ago');
    assert.match(format(app.now(), 'Rate limited', app.now() + 90000), /Rate limited · Updated just now · Retry at/);
    assert.equal(format(NaN), 'No data yet');
});

test('cooling sensor picks its sensor itself, even with an old manual choice saved', async () => {
    const rows = {
        pump: { name: 'CPU pump', type: 'rpm', units: 'RPM', value: '2400' },
        gpu: { name: 'GPU temperature', type: 'temperature', units: 'C', value: '55' }
    };
    const app = runtime('cooling-sensor-pump', {
        plugins: { Sensorsdataprovider: sensorPlugin(rows) }, pluginSensorsdataprovider_initialized: true,
        coolingAuto: false, coolingSensor: 'gpu'
    });
    await flush();
    assert.equal(app.get('value').textContent, '2400');
    assert.equal(app.get('label').textContent, 'Pump');
});

for (const widget of ['weather-now', 'daily-brief']) {
    test(`${widget} keeps weather content and shows its age after a failed refresh`, async () => {
        let offline = false;
        const app = runtime(widget, { fetch: async url => {
            if (offline) throw new Error('offline');
            return String(url).includes('geocoding') ? response({ results: [{ name: 'Paris', latitude: 48, longitude: 2 }] })
                : response({ current: { temperature_2m: 21, weather_code: 0 } });
        } });
        await flush();
        offline = true; app.at(app.now() + 300000);
        app.events.online(); await flush();
        assert.equal(Number(app.get('temp').textContent), 21);
        assert.equal(app.get('condition').textContent, 'Clear');
        assert.match(app.get('dataStatus').textContent, /Offline · Updated 5 min ago · Retry at/);
    });
}

test('ai cost prices tokens per provider and splits today from yesterday', async () => {
    const wire = { schema: 'ai-usage/1', providers: {
        claude: { model: { v: 'claude-sonnet-4-6' }, hours: [
            { start: Date.parse('2026-10-24T09:00:00Z'), input: 1e6, output: 1e5, cacheRead: 0, cacheWrite: 0 },
            { start: Date.parse('2026-10-23T12:00:00Z'), input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }
        ], days: [{ start: Date.parse('2026-10-24T00:00:00Z'), input: 1e6, output: 1e5, cacheRead: 0, cacheWrite: 0 }] },
        codex: { model: { v: 'gpt-5' }, hours: [{ start: Date.parse('2026-10-24T08:00:00Z'), input: 2e6, output: 0, cacheRead: 0, cacheWrite: 0 }], days: [] }
    } };
    const app = runtime('ai-cost', { fetch: async () => response(wire) });
    await flush();
    const s = app.context.AiCost.summarize(wire, app.now());
    assert.equal(Math.round(s.today * 100) / 100, 7);         // Claude 1M in + 0.1M out = $4.50, Codex 2M in = $2.50
    assert.equal(Math.round(s.yesterday * 100) / 100, 3);
    assert.equal(Math.round(s.month * 100) / 100, 4.5);
    assert.equal(s.tokensToday, 3.1e6);
    assert.equal(app.get('overlay').classList.contains('visible'), false);
    assert.equal(app.get('big').textContent, '$7');
    // The price class follows the model name, and a class chosen in iCUE wins.
    assert.equal(app.context.AiCost.tierOf('claude', 'claude-opus-5-5'), 'opus55');
    assert.equal(app.context.AiCost.tierOf('claude', 'claude-opus-4-1'), 'opus41');
    assert.equal(app.context.AiCost.tierOf('claude', 'claude-opus-4-7'), 'opus5');
    assert.equal(app.context.AiCost.tierOf('claude', 'claude-haiku-4-5'), 'haiku45');
    assert.equal(app.context.AiCost.tierOf('codex', 'gpt-5.5'), 'gpt55');
    assert.equal(app.context.AiCost.tierOf('codex', 'gpt-5-mini'), 'gpt5mini');
    const opus = runtime('ai-cost', { fetch: async () => response(wire), aiClaudePrice: 'opus55' });
    assert.equal(Math.round(opus.context.AiCost.summarize(wire, opus.now()).byProvider.claude * 100) / 100, 6);  // 1M x $4 + 0.1M x $20
});

test('ai cost keeps the last figures and says offline when the companion stops answering', async () => {
    const wire = { schema: 'ai-usage/1', providers: { claude: { model: { v: 'claude-sonnet-4-6' }, hours: [{ start: Date.parse('2026-10-24T09:00:00Z'), input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }], days: [] }, codex: { hours: [], days: [] } } };
    let up = true;
    const app = runtime('ai-cost', { fetch: async () => { if (!up) throw new Error('down'); return response(wire); } });
    await flush();
    up = false;
    app.runInterval(30000); await flush();
    assert.equal(app.get('badge').textContent, 'Offline');
    assert.equal(app.get('big').textContent, '$3');
    assert.equal(app.get('overlay').classList.contains('visible'), false);
});

test('screen time shows hours and minutes', () => {
    const app = runtime('screen-time', { fetch: async () => { throw new Error('down'); } });
    assert.deepEqual({ ...app.context.ScreenTime.parts(5 * 3600 + 42 * 60) }, { h: 5, m: 42 });
    assert.equal(app.context.ScreenTime.text(5 * 3600 + 42 * 60), '5 h 42');
    assert.equal(app.context.ScreenTime.text(600), '10 min');
});

test('sensor reader picks each role from iCUE ids and names, never a fan or a clock', () => {
    const window = { location: { search: '' } };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'shared/sensor-reader.js'), 'utf8'), { window, location: window.location, setInterval() {}, setTimeout() {} });
    const roles = window.SensorReader.roles;
    const icue = (pid, type, device, name = '') => ({ id: `vid<1b1c>pid<${pid}>serial<0>index<0>senstype<${type}>sensindex<0>`, name, device, type: '', kind: '', units: type.startsWith('Temp') ? '°C' : '%' });
    const m = (name, units, device = '') => ({ id: name, name, device, type: '', kind: '', units });
    // As iCUE writes them: the device name says neither CPU nor GPU.
    assert.ok(roles.cpuTemp(icue('000002', 'TemperaturePackage', 'Intel Core i9-14900K', 'Package')));
    assert.ok(roles.cpuLoad(icue('000002', 'Load', 'Intel Core i9-14900K')));
    assert.ok(roles.gpuTemp(icue('000007', 'Temperature', 'NVIDIA GeForce RTX 4080')));
    assert.ok(roles.gpuLoad(icue('000007', 'Load', 'NVIDIA GeForce RTX 4080')));
    assert.ok(roles.vram(icue('000007', 'FrameBufferLoad', 'NVIDIA GeForce RTX 4080')));
    assert.ok(!roles.gpuLoad(icue('000007', 'MemoryLoad', 'NVIDIA GeForce RTX 4080')));
    assert.ok(!roles.cpuTemp(icue('000007', 'Temperature', 'NVIDIA GeForce RTX 4080')));
    // Without senstype: from the names.
    assert.ok(roles.cpuLoad(m('CPU Total Load', '%')));
    assert.ok(roles.gpuTemp(m('Hot Spot', '°C', 'AMD Radeon RX 7900')));
    assert.ok(roles.cpuTemp(m('Tctl', '°C', 'AMD Ryzen 7 7800X3D')));
    assert.ok(roles.ram(m('Memory Usage', '%')));
    assert.ok(!roles.cpuLoad(m('CPU Fan', '%')));
    assert.ok(!roles.gpuLoad(m('GPU Core Clock', 'MHz')));
    // Watercooling.
    assert.ok(roles.liquid(m('Coolant Temp', '°C', 'iCUE LINK H150i')));
    assert.ok(roles.pump(m('Pump', 'RPM', 'iCUE LINK H150i')));
    assert.ok(!roles.pump(m('Pump Fan', '%')));
    assert.ok(!roles.liquid(m('Pump', 'RPM')));
    assert.ok(!roles.cpuTemp(m('Coolant Temp', '°C', 'iCUE LINK H150i')));
});

test('rig pet mood keeps its state near a threshold instead of flickering', () => {
    const src = fs.readFileSync(path.join(widgetDir('rig-pet'), 'app.js'), 'utf8');
    const moodFor = vm.runInNewContext(`(${src.match(/function moodFor[\s\S]*?\n    }/)[0]})`);
    assert.equal(moodFor(69, 40, 'calm'), 'calm');
    assert.equal(moodFor(70, 40, 'calm'), 'warm');
    assert.equal(moodFor(68, 40, 'warm'), 'warm');      // stays warm until 66
    assert.equal(moodFor(65, 40, 'warm'), 'calm');
    assert.equal(moodFor(80, 40, 'hot'), 'hot');        // stays hot until 78
    assert.equal(moodFor(77, 40, 'hot'), 'warm');
    assert.equal(moodFor(51, 10, 'sleepy'), 'sleepy');  // stays asleep until 53
    assert.equal(moodFor(51, 10, 'calm'), 'calm');
    assert.equal(moodFor(45, 10, ''), 'sleepy');
    // Thresholds from the settings, and an easier nap at night.
    assert.equal(moodFor(62, 40, 'calm', 60, 75), 'warm');
    assert.equal(moodFor(74, 40, 'warm', 60, 75), 'warm');
    assert.equal(moodFor(56, 30, 'calm', 70, 82, true), 'sleepy');
    assert.equal(moodFor(56, 30, 'calm', 70, 82, false), 'calm');
    const levelFor = vm.runInNewContext(`(${src.match(/const levelFor = (.*);/)[1]})`);
    assert.deepEqual([0, 39, 40, 360, 1000, 3240].map(levelFor), [1, 1, 2, 4, 6, 10]);
});

test('rig pet names a song cleanly from music players and video sites', () => {
    const src = fs.readFileSync(path.join(widgetDir('rig-pet'), 'app.js'), 'utf8');
    const body = src.match(/const TAG = [\s\S]*?function cleanSong[\s\S]*?\n    }/)[0];
    const run = vm.runInNewContext(`${body}; cleanSong`);
    const cleanSong = (t, a) => JSON.parse(JSON.stringify(run(t, a)));
    assert.deepEqual(cleanSong('Tarantino', 'LISA'), ['Tarantino', 'LISA']);
    assert.deepEqual(cleanSong('LISA - Tarantino (Official Music Video)', 'LISAVEVO'), ['Tarantino', 'LISA']);
    assert.deepEqual(cleanSong('Royalty [Lyrics]', 'Egzod - Topic'), ['Royalty', 'Egzod']);
    assert.deepEqual(cleanSong('Some vlog - part 2', 'A Channel'), ['Some vlog - part 2', 'A Channel']);
    assert.deepEqual(cleanSong('Midnight City', ''), ['Midnight City', '']);
});

test('energy cost counts watt-hours per hour and day, skips gaps, and prices them', () => {
    const window = { location: { search: '' }, addEventListener() {} };
    vm.runInNewContext(fs.readFileSync(path.join(widgetDir('energy-cost'), 'app.js'), 'utf8'), { window, location: window.location, document: { getElementById: () => ({ append() {} }), createElementNS: () => ({ setAttribute() {} }), createElement: () => ({ append() {}, style: {} }), documentElement: { style: { setProperty() {} }, classList: { toggle() {} } } }, setInterval() {}, setTimeout() {} });
    const { account, costs } = window.EnergyCost;
    const t0 = new Date(2026, 10, 4, 10, 0, 0).getTime();
    let s = account(null, 300, t0);                     // first reading: nothing measured yet
    for (let i = 1; i <= 720; i++) s = account(s, 300, t0 + i * 5000);   // one hour at 300 W
    assert.ok(Math.abs(s.hours[10] + s.hours[11] - 300) < 0.01 && s.hours[10] > 299, String(s.hours[10]));   // the last step ends at 11:00
    s = account(s, 300, t0 + 720 * 5000 + 3600000);     // an hour asleep: not counted
    assert.ok(Math.abs(s.days['2026-11-04'] - 300) < 0.01);
    const c = costs(s, 0.25, t0 + 3600000);
    assert.ok(Math.abs(c.today - 0.075) < 1e-6, String(c.today));
    s = account(s, 300, new Date(2026, 10, 5, 0, 0, 1).getTime());     // next day: today's hours start again
    assert.equal(s.hours.reduce((a, b) => a + b, 0), 0);
    assert.ok(s.days['2026-11-04'] > 0);
});

test('game session averages the frame rate, finds the 1 % low and thins long sessions', () => {
    const window = { location: { search: '' }, addEventListener() {} };
    const sandbox = { window, location: window.location, document: { body: { dataset: {} }, getElementById: () => ({ textContent: '', dataset: {}, classList: { toggle() {} }, style: { setProperty() {} }, setAttribute() {} }) }, setInterval() {}, setTimeout() {}, Promise };
    sandbox.window.WidgetRuntime = { storage: () => ({ read: () => null, write() {} }), requestJson: () => new Promise(() => {}) };
    vm.runInNewContext(fs.readFileSync(path.join(widgetDir('game-session'), 'app.js'), 'utf8'), sandbox);
    const { summarize, thin } = window.GameSession;
    const samples = Array.from({ length: 200 }, (_, i) => (i < 2 ? 30 : 144));
    const r = summarize(samples);
    assert.equal(Math.round(r.avg), Math.round((2 * 30 + 198 * 144) / 200));
    assert.equal(r.low, 30);
    assert.equal(summarize([]).avg, null);
    assert.ok(thin(Array(2401).fill(100)).length < 2401);
});

test('grid pulse grades carbon intensity and splits the mix; ci radar picks a lamp per run', () => {
    const run = (name, extra = {}) => {
        const window = { location: { search: '' }, addEventListener() {}, ...extra };
        const el = () => ({ textContent: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, replaceChildren() {}, append() {}, addEventListener() {} });
        vm.runInNewContext(fs.readFileSync(path.join(widgetDir(name), 'app.js'), 'utf8'), { window, location: window.location, document: { body: { dataset: {} }, getElementById: el, createElement: el }, WidgetRuntime: { requestJson: () => new Promise(() => {}), onResume() {}, storage: () => ({ read: () => null, write() {} }) }, setInterval() {}, setTimeout() {} });
        return window;
    };
    const { level, shares, cleanerThan } = run('grid-pulse').GridPulse;
    assert.equal(level(20)[0], 'vlow'); assert.equal(level(60)[0], 'low'); assert.equal(level(100)[0], 'mid'); assert.equal(level(200)[0], 'high');
    const s = shares({ nucleaire: 60, eolien: 20, solaire: 20, gaz: 0, fioul: -5 });
    assert.equal(s.length, 3); assert.equal(s[0].name, 'Nuclear'); assert.equal(Math.round(s[0].pct), 60);
    assert.equal(cleanerThan([10, 50, 90, 120], 60), 50);
    const { lamp } = run('ci-radar').CiRadar;
    assert.equal(lamp({ status: 'completed', conclusion: 'success' }), 'green');
    assert.equal(lamp({ status: 'in_progress' }), 'amber');
    assert.equal(lamp({ status: 'completed', conclusion: 'failure' }), 'red');
    assert.equal(lamp({ status: 'completed', conclusion: 'cancelled' }), 'off');
    assert.equal(lamp(undefined), 'off');
    const { merge } = run('patch-radar').PatchRadar;
    const m = merge([{ name: 'A', items: [{ at: 1 }, { at: 5 }] }, { name: 'B', items: [{ at: 3 }] }], 2);
    assert.equal(m.map(x => x.game + x.at).join(','), 'A5,B3');
});

test('companion window scripts parse (a broken quote leaves the whole window blank)', () => {
    const dir = path.join(root, 'companion/web');
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
        assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: f }), f);
    }
});
