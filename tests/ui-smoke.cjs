// Use an existing Playwright installation: node tests/ui-smoke.cjs <module-path>
// API/plugin responses are fixtures. Only the existing pinned Leaflet CDN assets are fetched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'icue-ui-'));
const sizes = [[840, 344], [696, 416], [840, 696], [696, 840], [1688, 696], [696, 1688], [2536, 696], [696, 2536]];
const pumps = [[480, 480], [616, 224], [616, 456], [456, 616], [456, 304], [696, 308], [696, 624], [696, 1256], [624, 344], [624, 696], [1256, 696]];

async function main() {
    const executablePath = process.argv[3] || [
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Google/Chrome/Application/chrome.exe'
    ].find(fs.existsSync);
    const browser = await chromium.launch({ executablePath, headless: true });
    const report = [];
    try {
        const context = await browser.newContext({ reducedMotion: 'reduce', timezoneId: 'Europe/Paris', hasTouch: true });
        await context.route('**/*', async route => {
            const u = new URL(route.request().url());
            if (u.hostname === 'icue-audit.local') {
                const file = path.resolve(root, '.' + decodeURIComponent(u.pathname));
                if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
                return route.fulfill({ body: fs.readFileSync(file), contentType: {
                    '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript'
                }[path.extname(file)] || 'text/plain' });
            }
            if (u.hostname === 'unpkg.com' && u.pathname.startsWith('/leaflet@1.9.4/dist/')) return route.continue();
            let data;
            if (u.hostname === 'geocoding-api.open-meteo.com') data = { results: [{ name: 'Paris', country_code: 'FR', latitude: 48, longitude: 2 }] };
            if (u.hostname === 'api.open-meteo.com') data = { current: {
                temperature_2m: 21, weather_code: 0, wind_speed_10m: 8, precipitation: 0
            }, daily: { sunrise: ['2026-09-27T07:30'], sunset: ['2026-09-27T19:30'] } };
            if (u.hostname === 'api.github.com') data = u.pathname.endsWith('/commits')
                ? [{ sha: 'abcdef0', commit: { message: 'Improve widget reliability' } }]
                : u.pathname.endsWith('/issues') ? Array.from({ length: 12 }, (_, i) => i < 3 ? { pull_request: {} } : {})
                    : { default_branch: 'main', stargazers_count: 142, pushed_at: '2026-09-27' };
            if (u.hostname === 'api.wheretheiss.at') data = { latitude: 48, longitude: 2, altitude: 408, velocity: 27600 };
            if (data) return route.fulfill({ json: data, headers: { 'access-control-allow-origin': '*' } });
            if (route.request().resourceType() === 'image') return route.fulfill({
                contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=', 'base64')
            });
            return route.abort();
        });
        await context.addInitScript(() => {
            window.countdown1Date = '2026-12-31';
            window.countdown1Label = 'Year end';
            window.countdown2Date = '2027-02-01';
            window.countdown2Label = 'Next milestone';
            window.countdown3Date = '2027-03-01';
            window.countdown3Label = 'Spring';
            window.clockFormat = '12h';
            let receiver;
            const reply = (id, value) => queueMicrotask(() => receiver(id, value));
            window.plugins = {
                Mediadataprovider: { songName: 'A quiet moment', artist: 'Example artist' },
                Sensorsdataprovider: {
                    asyncResponse: { connect(fn) { receiver = fn; } },
                    sensorValueChanged: { connect() {} },
                    getAllSensorIds(id) { reply(id, ['cpu-pump']); },
                    getSensorName(id) { reply(id, 'Pump'); },
                    getSensorDeviceName(id) { reply(id, 'CORSAIR Cooling'); },
                    getSensorType(id) { reply(id, 'rpm'); },
                    getSensorKind(id) { reply(id, 'pump'); },
                    getSensorUnits(id) { reply(id, 'RPM'); },
                    getSensorValue(id) { reply(id, '2400'); }
                }
            };
            window.pluginSensorsdataprovider_initialized = true;
        });
        for (const slug of ['focus-timer', 'habit-rings', 'weather-now', 'daily-brief', 'countdowns', 'github-repo-monitor', 'world-clock', 'iss-horizon', 'cooling-sensor-pump', 'windows-media-pump']) {
            const page = await context.newPage();
            const errors = [], violations = [];
            page.on('pageerror', e => errors.push(e.message));
            page.on('console', m => { if (m.type() === 'error' && /Content Security Policy/.test(m.text())) violations.push(m.text()); });
            if (slug === 'habit-rings') await page.clock.install({ time: new Date('2026-09-27T23:59:00+02:00') });
            await page.goto(`http://icue-audit.local/widgets/${slug.endsWith('-pump') ? 'pump' : 'xeneon-edge'}/${slug}/index.html`);
            await page.waitForLoadState('networkidle');
            if (slug === 'iss-horizon') {
                assert.equal(await page.evaluate(() => typeof L), 'object', 'Leaflet must load for the map layout check');
                for (const style of ['dark', 'day', 'satellite', 'auto']) {
                    await page.evaluate(value => { window.issMapStyle = value; window.IssHorizonIcue.syncMapStyle(); }, style);
                    await page.waitForTimeout(100);
                    const map = await page.evaluate(() => ({
                        urls: [...document.querySelectorAll('.leaflet-tile-pane img')].map(e => e.src),
                        filter: getComputedStyle(document.querySelector('.leaflet-tile-pane')).filter,
                        attribution: document.querySelector('.leaflet-control-attribution').textContent
                    }));
                    assert.ok(map.urls.length > 0, 'map must create tile images');
                    assert.ok(map.urls.every(url => !url.includes('cartocdn')), 'no key-protected CARTO tiles');
                    if (style === 'satellite') {
                        assert.equal(map.filter, 'none', 'satellite colors are preserved');
                        assert.match(map.attribution, /Esri/);
                    } else {
                        assert.ok(map.urls.every(url => url.startsWith('https://tile.openstreetmap.org/')));
                        assert.match(map.filter, /grayscale/);
                        assert.match(map.attribution, /OpenStreetMap/);
                    }
                }
                await page.evaluate(() => { window.issMapStyle = 'dark'; window.IssHorizonIcue.syncMapStyle(); });
                await page.waitForTimeout(900);
                await page.locator('#btnPass').focus();
                await page.keyboard.press('Enter');
                await page.waitForSelector('.leaflet-popup-content');
                assert.match(await page.locator('.leaflet-popup-content').textContent(), /Estimated next pass/);
                assert.match(await page.locator('.leaflet-popup-content').textContent(), /in ~0min/);
                assert.equal(await page.locator('#btnFollow').getAttribute('aria-pressed'), 'false');
                await page.locator('.leaflet-popup-close-button').click();
                await page.waitForSelector('.leaflet-popup-content', { state: 'detached' });
                const bounds = await page.locator('#issMap').boundingBox();
                await page.touchscreen.tap(bounds.x + bounds.width * 0.7, bounds.y + bounds.height * 0.55);
                await page.waitForSelector('.leaflet-popup-content');
                assert.match(await page.locator('.leaflet-popup-content').textContent(), /Estimated next pass|No nearby pass found/);
                await page.locator('.leaflet-popup-close-button').click();
                await page.waitForSelector('.leaflet-popup-content', { state: 'detached' });
                await page.locator('#issMap').focus(); await page.keyboard.press('ArrowRight');
                assert.equal(await page.locator('#btnFollow').getAttribute('aria-pressed'), 'false');
                await page.locator('#btnFollow').click();
                assert.equal(await page.locator('#btnFollow').getAttribute('aria-pressed'), 'true');
            }
            if (slug === 'habit-rings') {
                const add = page.locator('button.add').first();
                await add.focus(); await page.keyboard.press('Enter');
                assert.equal(await page.evaluate(() => document.activeElement.dataset.index), '0', 'habit button keeps keyboard focus');
                assert.equal(await add.evaluate(e => getComputedStyle(e).outlineStyle), 'solid', 'keyboard focus is visible');
                const offset = await page.locator('.fill').first().evaluate(e => parseFloat(getComputedStyle(e).strokeDashoffset));
                assert.ok(Math.abs(offset - 326.726 * 7 / 8) < 0.1, 'ring reflects the new progress under CSP');
                await page.clock.setSystemTime(new Date('2026-09-28T00:01:00+02:00'));
                await page.clock.runFor(60001);
                assert.equal(await page.locator('.habit-footer span').first().textContent(), '0 / 8', 'daily counts roll over without a click');
                await add.click();
            }
            const dimensions = slug.endsWith('-pump') ? pumps : sizes;
            for (const [width, height] of dimensions) {
                await page.setViewportSize({ width, height });
                await page.evaluate(() => new Promise(requestAnimationFrame));
                if (slug === 'iss-horizon') await page.waitForTimeout(300);
                const clipped = await page.evaluate(() => {
                    const targets = 'button, .x-value, #temp, #unit, #local, #clock, #nextDays, .tel-val, #value, #units, .track-name, #dataStatus';
                    return [...document.querySelectorAll(targets)].flatMap(e => {
                        const r = e.getBoundingClientRect();
                        if (!r.width || !r.height) return [];
                        const reasons = [];
                        if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) reasons.push('viewport');
                        if (e.matches('.x-value, #local') && e.scrollWidth > e.clientWidth + 2) reasons.push('text width');
                        for (let parent = e.parentElement; parent; parent = parent.parentElement) {
                            const style = getComputedStyle(parent), p = parent.getBoundingClientRect();
                            if (style.overflowY === 'hidden' && (r.top < p.top - 2 || r.bottom > p.bottom + 2)) reasons.push('parent height');
                            if (style.overflowX === 'hidden' && (r.left < p.left - 2 || r.right > p.right + 2)) reasons.push('parent width');
                        }
                        return reasons.length ? [{ element: e.id || e.className, text: e.textContent, reasons }] : [];
                    });
                });
                report.push({ slug, width, height, clipped });
                if (!slug.endsWith('-pump')) {
                    const small = await page.evaluate(() => {
                        const rules = [
                            ['.x-label, .x-kicker, .tel-header, .solar-badge', 18],
                            ['#dataStatus', 16],
                            ['.ctrl, .reset, .add, .follow-btn', 20]
                        ];
                        const failures = [];
                        for (const [selector, minimum] of rules) for (const e of document.querySelectorAll(selector)) {
                            if (!e.getBoundingClientRect().height) continue;
                            if (parseFloat(getComputedStyle(e).fontSize) < minimum) failures.push(e.id || e.className);
                        }
                        for (const e of document.querySelectorAll('.ctrl, .reset, .add, .follow-btn')) {
                            const r = e.getBoundingClientRect();
                            if (r.height && (r.height < 60 || r.width < 60)) failures.push(e.id || e.className);
                        }
                        return failures;
                    });
                    assert.deepEqual(small, [], `${slug} ${width}x${height}: minimum readable text and control sizes`);
                }
            }
            if (slug === 'weather-now' || slug === 'daily-brief') {
                await page.route('https://api.open-meteo.com/**', route => route.fulfill({
                    json: { current: { temperature_2m: 123, weather_code: 0, wind_speed_10m: 130, precipitation: 100 } },
                    headers: { 'access-control-allow-origin': '*' }
                }));
                await page.evaluate(widget => {
                    window[widget === 'weather-now' ? 'weatherUnits' : 'briefUnits'] = 'fahrenheit';
                    window.icueEvents.onDataUpdated();
                }, slug);
                await page.waitForFunction(() => document.getElementById('temp').textContent === '123');
                for (const [width, height] of [[840, 344], [840, 696], [696, 840]]) {
                    await page.setViewportSize({ width, height });
                    const clipped = await page.locator('#temp, #unit, #wind, #rain').evaluateAll(elements => elements.filter(e => {
                        const r = e.getBoundingClientRect();
                        for (let p = e.parentElement; p; p = p.parentElement) {
                            const s = getComputedStyle(p), bounds = p.getBoundingClientRect();
                            if (s.overflowX === 'hidden' && (r.left < bounds.left - 2 || r.right > bounds.right + 2)) return true;
                            if (s.overflowY === 'hidden' && (r.top < bounds.top - 2 || r.bottom > bounds.bottom + 2)) return true;
                        }
                        return e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 2;
                    }).map(e => e.id));
                    if (clipped.length) {
                        await page.screenshot({ path: path.join(output, `${slug}-long-values.png`) });
                        console.log(JSON.stringify(await page.locator('#temp').evaluate(e => {
                            const chain = [];
                            for (let p = e; p; p = p.parentElement) {
                                const s = getComputedStyle(p);
                                chain.push({ tag: p.tagName, id: p.id, class: p.className, rect: p.getBoundingClientRect().toJSON(), overflow: s.overflow, font: s.fontSize });
                            }
                            return chain;
                        })));
                    }
                    assert.deepEqual(clipped, [], `${slug} ${width}x${height}: three-digit weather values`);
                }
                await page.unroute('https://api.open-meteo.com/**');
                await page.reload(); await page.waitForLoadState('networkidle');
            }
            if (slug === 'world-clock') {
                await page.evaluate(() => { window.clockTz1 = 'Invalid/Zone'; window.icueEvents.onDataUpdated(); });
                assert.equal(await page.locator('[data-date]').first().textContent(), 'Invalid time zone');
                await page.evaluate(() => { window.clockTz1 = 'Europe/Paris'; window.icueEvents.onDataUpdated(); });
            }
            if (slug === 'daily-brief') {
                await page.setViewportSize({ width: 840, height: 344 });
                await page.route('https://api.open-meteo.com/**', route => route.fulfill({ status: 503, json: { error: true }, headers: { 'access-control-allow-origin': '*' } }));
                await page.evaluate(() => { window.briefCity = 'Another city'; window.icueEvents.onDataUpdated(); });
                await page.waitForSelector('#overlay.visible');
                for (const id of ['clock', 'dataStatus']) {
                    assert.equal(await page.locator(`#${id}`).evaluate(e => {
                        const r = e.getBoundingClientRect();
                        return e.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
                    }), true, `${id} stays visible above the weather error`);
                }
                await page.screenshot({ path: path.join(output, 'daily-brief-offline.png') });
                await page.unroute('https://api.open-meteo.com/**');
                await page.reload(); await page.waitForLoadState('networkidle');
            }
            await page.setViewportSize(slug.endsWith('-pump') ? { width: 480, height: 480 } : { width: 840, height: 344 });
            if (slug === 'iss-horizon') await page.waitForTimeout(300);
            await page.screenshot({ path: path.join(output, `${slug}.png`) });
            if (slug === 'iss-horizon') {
                await page.evaluate(() => {
                    const key = 'icue-edge-widgets:iss-cache';
                    const data = JSON.parse(localStorage.getItem(key));
                    data['iss-cache'].fetchedAt = Date.now() - 60000;
                    localStorage.setItem(key, JSON.stringify(data));
                });
                await page.route('https://api.wheretheiss.at/**', route => route.fulfill({ status: 503, json: {}, headers: { 'access-control-allow-origin': '*' } }));
                await page.reload(); await page.waitForLoadState('networkidle');
                await page.locator('#btnPass').click();
                await page.waitForSelector('.leaflet-popup-content');
                assert.match(await page.locator('.leaflet-popup-content').textContent(), /Position unavailable/);
                await page.route('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', route => route.abort());
                await page.reload(); await page.waitForLoadState('networkidle');
                assert.equal(await page.locator('#mapStatus').textContent(), 'Map library unavailable');
                assert.equal(await page.locator('#btnPass').isDisabled(), true);
            }
            assert.deepEqual(errors, [], `${slug}: JavaScript errors`);
            assert.deepEqual(violations, [], `${slug}: security policy violations`);
            await page.close();
        }
        const clipped = report.filter(r => r.clipped.length);
        fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ views: report.length, output, clipped }, null, 2));
        assert.equal(clipped.length, 0, 'all primary values and controls fit');
    } finally {
        await browser.close();
        console.log(`Screenshots and diagnostics: ${output}`);
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
