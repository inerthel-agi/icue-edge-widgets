(() => {
    "use strict";

    const $ = id => document.getElementById(id);
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const DEMO = /[?&]demo\b/.test(location.search);
    const ENDPOINT = "http://127.0.0.1:47821";

    const setting = (name, fallback) => (typeof window[name] === "string" && window[name].trim() ? window[name].trim().slice(0, 24) : fallback);
    const flag = (name, fallback) => (window[name] === undefined || window[name] === null ? fallback : window[name] !== false && window[name] !== "false");
    const num = (name, fallback) => (Number.isFinite(Number(window[name])) && window[name] !== "" && window[name] !== null ? Number(window[name]) : fallback);
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

    // Mood from the hotter of CPU and GPU (°C) and the higher load (%). Leaving a mood needs a few degrees
    // more than entering it, so a temperature that hovers on a line does not make the pet flicker.
    // At night the pet falls asleep more easily.
    function moodFor(t, l, prev, warm = 70, hot = 82, night = false) {
        if (t >= hot || (prev === "hot" && t >= hot - 4)) return "hot";
        if (t >= warm || ((prev === "warm" || prev === "hot") && t >= warm - 4)) return "warm";
        const nap = night ? warm - 12 : warm - 20, quiet = night ? 35 : 25;
        if ((t < nap && l < quiet) || (prev === "sleepy" && t < nap + 3 && l < quiet + 5)) return "sleepy";
        return "calm";
    }

    // Level from experience points: level 2 after 40 points, 4 after 360, 6 after 1000, 10 after 3240.
    const levelFor = xp => 1 + Math.floor(Math.sqrt(Math.max(0, xp) / 40));
    const xpFor = level => 40 * (level - 1) ** 2;
    // Accessories earned by level; "Best earned" shows the last one reached.
    const HATS = [[10, "crown"], [6, "wizard"], [4, "bow"]];

    // What the pet says: a line per mood or activity, changed every 15 s. {hot} is the hotter part with its
    // reading, {for} how long the mood has lasted; a line whose figure is missing is skipped.
    const LINES = {
        sleepy: ["Nice and cool. Nap time.", "Zzz… only {load} load.", "Quiet PC, quiet pet.", "Cool as can be: {hot}."],
        night: ["It's late… {time}.", "Night owl, are we?", "Zzz… wake me at sunrise."],
        calm: ["All good in here.", "Comfy: {hot}.", "Calm for {for} now.", "CPU {cpu}, GPU {gpu}. Nice.", "Nice and steady."],
        warm: ["Getting warm in here…", "{hot}. I'm sweating.", "Busy, busy: {load} load.", "Warm for {for} already."],
        hot: ["Too hot! Check the fans.", "{hot}! Help!", "It's an oven in here.", "Hot for {for}. Fans, please!"],
        cooled: ["Phew, cooled down!", "Ahh, much better.", "Back to normal."],
        tap: ["Hi!", "Hehe, that tickles.", "Hello there!", "You found me!"],
        fetch: ["Got it!", "Again! Again!", "Fetched!"],
        level: ["Level {level}! Look at me!", "Level up: {level}!"],
        game: ["{fps} FPS, let's go!", "Game on!", "Go go go! {fps} FPS."],
        music: ["Nice tune: {song}.", "♪ {song} ♪", "I love this one.", "{artist} on repeat? Fine by me."],
        // A new song starts: the pet names it and praises your taste; "fav" once an artist came back three times.
        taste: ["{song} by {artist}? You have great taste.", "Ooh, {artist}! Good pick.", "{song}… this one slaps.", "Your taste in music: chef's kiss.", "Nice track: {song}."],
        fav: ["{artist} again? I approve.", "You really like {artist}. Me too!", "Another {artist} song. Taste confirmed.", "{artist}, our favourite."],
        claude: ["Claude is {verb}…", "Claude Code at work.", "Shh, Claude is thinking."],
        tired: ["So tired… let it cool down.", "Out of energy.", "Need a break…"],
        sulk: ["Hmph. Nobody plays with me.", "…", "Pet me, maybe?"],
    };
    // Personalities change some lines, the walking speed and how often the pet goes for a walk.
    const PERSONA = {
        calm: { speed: 1, pause: 1, lines: {} },
        energetic: { speed: 1.6, pause: 0.45, lines: {
            calm: ["Let's do something!", "Woohoo! {hot} and fine!", "Ready for anything!"],
            warm: ["Warm-up done! {hot}!", "Feeling the heat, love it!"],
            tap: ["Yay! Hi!!", "Again! Again!", "High five!"],
            taste: ["{artist}!! Turn it up!", "{song}! Let's dance!", "Banger alert: {song}!"],
        } },
        grumpy: { speed: 0.8, pause: 1.7, lines: {
            calm: ["Fine. {hot}. Whatever.", "Leave me alone.", "Hmph."],
            warm: ["Ugh, {hot}. Typical.", "Who turned the heat on?"],
            hot: ["{hot}. I told you so.", "Unbearable."],
            tap: ["What?", "Don't poke me.", "…hi."],
            fetch: ["Fine. Here's your ball.", "Happy now?"],
            taste: ["{song}. Not bad. For you.", "{artist}? …acceptable.", "Hmph. Good song, I guess."],
        } },
    };

    const NAMES = { bit: "Bit", claude: "Claude", ghost: "Ghost", robot: "Robot", slime: "Slime", clawd: "Clawd", grace: "Grace", sealion: "Sea Lion", jennie: "Jennie", claire: "Claire", dario: "Dario", tom: "Tom", patrick: "Patrick", pepe: "Pepe", rick: "Rick", doge: "Doge", elon: "Mini Elon", kirby: "Kirby", clippy: "Clippy", tux: "Tux", frieren: "Frieren", anya: "Anya", miku: "Miku", luffy: "Luffy", goku: "Goku", gojo: "Gojo", umaru: "Umaru", asuka: "Asuka", doraemon: "Doraemon", elaina: "Elaina", violet: "Violet", bocchi: "Bocchi", xiaohei: "Luo Xiaohei", sama: "Mini Sama", doro: "Doro", guga: "Guga", kiki: "Kiki", usagi: "Usagi", hachiware: "Hachiware", custom: "Pet" };
    // An empty name, or the old default "Bit" on another mascot, shows the mascot's own name.
    function petName() {
        const kind = String(window.petKind || "bit");
        const n = setting("petName", "");
        return !n || (n === "Bit" && kind !== "bit") ? NAMES[kind] || "Bit" : n;
    }
    const celsius = t => (t && /f/i.test(String(t.units)) && !/c/i.test(String(t.units)) ? (t.value - 32) * 5 / 9 : t ? t.value : NaN);
    const deg = t => (t ? `${Math.round(t.value)}${String(t.units || "°C").trim()}` : "");
    const span = ms => (ms < 60000 ? "a moment" : ms < 3600000 ? `${Math.round(ms / 60000)} min` : `${Math.floor(ms / 3600000)} h ${String(Math.round(ms % 3600000 / 60000)).padStart(2, "0")}`);
    const today = () => new Date().toDateString();
    const isNight = () => { const h = new Date().getHours(); return h >= 23 || h < 7; };
    const persona = () => PERSONA[String(window.petPersonality)] || PERSONA.calm;

    const state = { mood: "", since: Date.now(), line: "", lineAt: 0, vars: {}, sayUntil: 0, activity: "", need: "" };
    const preview = { on: false, i: 0, at: 0, kept: "" };   // the Preview mode setting; see SCENES below

    function say(pool, force) {
        const now = Date.now();
        if (!force && (now < state.sayUntil || now - state.lineAt < 15000)) return;
        const fill = s => s.replace(/\{(\w+)\}/g, (_, k) => state.vars[k] || "\u0000");
        const source = persona().lines[pool] || LINES[pool];
        const lines = source.map(fill).filter(s => !s.includes("\u0000") && s !== state.line);
        state.line = lines.length ? lines[Math.floor(Math.random() * lines.length)] : fill(source[0]).replace(/\u0000/g, "");
        state.lineAt = now;
        $("say").textContent = state.line;
    }
    function shout(pool, ms) { say(pool, true); state.sayUntil = Date.now() + ms; }

    // ---------- Memory: needs, experience and today's figures, kept by iCUE for this widget ----------
    const store = WidgetRuntime.storage("rig-pet", "icue-edge-widgets:rig-pet");
    const life = Object.assign({ energy: 80, joy: 70, xp: 0, at: Date.now(), day: { date: today(), max: 0, calm: 0, hot: 0, taps: 0, fetches: 0 } }, store.read() || {});
    if (!life.day || life.day.date !== today()) life.day = { date: today(), max: 0, calm: 0, hot: 0, taps: 0, fetches: 0 };
    let savedAt = 0;
    function save(now) { if (!preview.on && now - savedAt > 30000) { savedAt = now; store.write(life); } }

    function gain(xp) {
        if (preview.on) return;
        const before = levelFor(life.xp);
        life.xp += xp;
        if (levelFor(life.xp) > before) { state.vars.level = String(levelFor(life.xp)); react(4, "hop", 1200); shout("level", 6000); }
    }

    // Needs follow the PC: heat drains energy, cool time restores it; joy fades slowly unless you play.
    function live(now) {
        const min = clamp((now - life.at) / 60000, 0, 24 * 60);   // a long sleep counts, but not forever
        life.at = now;
        const rate = { sleepy: 2, calm: 1, warm: -0.6, hot: -2 }[state.mood] || 0;
        life.energy = clamp(life.energy + rate * min, 0, 100);
        life.joy = clamp(life.joy - min / 15, 0, 100);   // -4 an hour
        if (min < 5) life.xp += min;                       // a point a minute together
        if (life.day.date !== today()) life.day = { date: today(), max: 0, calm: 0, hot: 0, taps: 0, fetches: 0 };
        if (state.mood === "calm" || state.mood === "sleepy") life.day.calm += min * 60000;
        if (state.mood === "hot") life.day.hot += min * 60000;
        state.need = preview.on ? scene().need || "" : life.energy < 15 ? "tired" : life.joy < 20 ? "sulk" : "";
        $("widget").dataset.need = state.need;
        $("energy").style.width = `${life.energy}%`;
        $("joy").style.width = `${life.joy}%`;
        const lv = levelFor(life.xp);
        $("xp").style.width = `${(life.xp - xpFor(lv)) / (xpFor(lv + 1) - xpFor(lv)) * 100}%`;
        $("level").textContent = `Lv ${lv}`;
        const d = life.day;
        $("today").textContent = preview.on ? `Preview ${preview.i + 1}/${SCENES.length}: ${scene().label}`
            : `Today: max ${Math.round(d.max)}°C · calm ${span(d.calm)} · ${d.taps} pets · ${d.fetches} balls · ${d.songs || 0} songs`;
        // The best accessory earned, unless set to none; headphones while music plays.
        const hat = preview.on ? scene().hat || "" : setting("petAccessory", "auto") === "none" ? "" : (HATS.find(([n]) => lv >= n) || [0, ""])[1];
        $("acc").dataset.hat = hat;
        $("acc").dataset.phones = String(state.activity === "music");
        save(now);
    }

    // ---------- Your own pictures, one per mood (iCUE media-selector) ----------
    const MEDIA = { calm: "petCalm", sleepy: "petSleepy", warm: "petWarm", hot: "petHot" };
    const VIDEO = /\.(mp4|webm|ogg|mov|mkv)$/i;
    const broken = new Set();   // files that failed once are not retried until the setting changes

    // iCUE gives an object with pathToAsset (or a bare string); a Windows path becomes a file: URL.
    function mediaUrl(value) {
        const raw = !value ? "" : typeof value === "string" ? value : value.pathToAsset || value.path || value.value || "";
        const p = String(raw).trim();
        if (!p) return "";
        if (/^(file|https?|data|blob):/i.test(p)) return p;
        if (/^[a-z]:[\\/]/i.test(p) || p.startsWith("\\\\")) return `file:///${encodeURI(p.replace(/\\/g, "/").replace(/^\/+/, "")).replace(/[?#]/g, encodeURIComponent)}`;
        return p;
    }

    // ---------- Pixel pets: a spritesheet of 8 columns, one animation per row ----------
    // Rows of a Codex pet sheet (192 x 208 cells): 0 idle, 1 run right, 2 run left, 3 wave, 4 jump,
    // 5 failed, 6 waiting, 7 running, 8 review.
    const FRAMES = [6, 8, 8, 4, 5, 8, 6, 6, 6];
    const ROW = { calm: 0, sleepy: 6, warm: 7, hot: 5 };
    const ACTIVITY_ROW = { game: 7, claude: 8, music: 0 };
    // Sheets whose two run rows do not face opposite ways: [the run row to use, the way it faces]. The other way is mirrored.
    const ONE_WAY = { sealion: [1, -1], goku: [1, 1], doraemon: [1, 1], elaina: [1, 1], violet: [1, 1], doro: [1, -1] };
    const sheet = { url: "", rows: 0, row: -1, frame: 0, tick: 0, timer: 0 };
    const action = { row: -1, until: 0 };   // a short one-off: wave on a tap, jump on cooling down
    const walk = { x: 0, dir: 1, moving: false, next: Date.now() + 3000, timer: 0, onArrive: null };

    function currentRow() {
        if (Date.now() < action.until && action.row >= 0) return action.row;
        const one = ONE_WAY[$("widget").dataset.sheet];
        if (walk.moving) return one ? one[0] : walk.dir > 0 ? 1 : 2;
        if (state.mood === "hot") return ROW.hot;
        if (state.need === "tired") return ROW.sleepy;
        if (state.activity && ACTIVITY_ROW[state.activity] !== undefined) return ACTIVITY_ROW[state.activity];
        return ROW[state.mood] || 0;
    }

    function spriteStep() {
        const row = Math.min(currentRow(), Math.max(0, sheet.rows - 1));
        if (row !== sheet.row) { sheet.row = row; sheet.frame = -1; }
        const one = ONE_WAY[$("widget").dataset.sheet];
        $("sprite").classList.toggle("flip", !!one && walk.moving && walk.dir !== one[1]);
        // Waiting and failed play at half speed: a sleepy or worn-out pet moves slowly.
        if ((row === 6 || row === 5) && ++sheet.tick % 2) return;
        sheet.frame = (sheet.frame + 1) % (FRAMES[row] || 6);
        $("sprite").style.backgroundPosition = `${sheet.frame / 7 * 100}% ${sheet.rows > 1 ? row / (sheet.rows - 1) * 100 : 0}%`;
        fitAccessory();
    }

    // Where the head is in each frame of the sheet, in cell pixels: [top, centre x, width]. Measured once from
    // the picture itself, so a hat or headphones follow the head as it moves. Only for the shipped sheets:
    // a picture from another place cannot be read back by the page.
    function measureHeads(img) {
        const cw = img.naturalWidth / 8, ch = cw * 208 / 192;
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        const heads = [];
        for (let r = 0; r < sheet.rows; r++) {
            heads.push([]);
            for (let f = 0; f < 8; f++) {
                const px = g.getImageData(Math.round(f * cw), Math.round(r * ch), Math.round(cw), Math.round(ch)).data;
                const W = Math.round(cw), H = Math.round(ch);
                const solid = (x, y) => px[(y * W + x) * 4 + 3] > 60;
                let top = -1, bottom = -1;
                for (let y = 0; y < H && top < 0; y++) for (let x = 0; x < W; x++) if (solid(x, y)) { top = y; break; }
                for (let y = H - 1; y >= 0 && bottom < 0; y--) for (let x = 0; x < W; x++) if (solid(x, y)) { bottom = y; break; }
                if (top < 0) { heads[r].push(null); continue; }
                // The head's width: the widest span in the band just under the top of the figure.
                const fh = bottom - top;
                const span = (a, b) => {
                    let left = W, right = -1;
                    for (let y = Math.round(a); y <= Math.round(b); y++) for (let x = 0; x < W; x++) if (solid(x, y)) { left = Math.min(left, x); right = Math.max(right, x); }
                    return [left, right];
                };
                let [left, right] = span(top + fh * 0.08, top + fh * 0.26);
                if (right < left) { heads[r].push(null); continue; }
                // Ears, horns and hair spikes are thin: the hat sits where the row is mostly filled.
                let skull = top;
                for (let y = top; y < top + fh * 0.3; y++) {
                    let n = 0;
                    for (let x = left; x <= right; x++) if (solid(x, y)) n++;
                    if (n >= (right - left) * 0.55) { skull = y; break; }
                }
                if (skull > top) [left, right] = span(skull, skull + fh * 0.16);
                heads[r].push([skull, (left + right) / 2, right - left]);
            }
        }
        return heads;
    }

    // Moves and scales the hat or headphones (drawn for a head with its top at y 30, 96 wide, centred on x 100)
    // onto the pixel pet's head in the frame shown.
    function fitAccessory() {
        const acc = $("acc"), fx = $("fx"), sp = $("sprite");
        const head = sheet.heads && sheet.heads[sheet.row] && sheet.heads[sheet.row][sheet.frame];
        if ($("widget").dataset.pet !== "codex" || !head) { acc.style.transform = acc.style.transformOrigin = fx.style.transform = fx.style.transformOrigin = ""; return; }
        const W = acc.clientWidth, H = acc.clientHeight, S = Math.min(W, H), u = S / 200;
        // Headphones sit lower and a little tighter than a hat: the band rests on the head, the cups on its sides.
        const phones = acc.dataset.phones === "true";
        const ox = (W - S) / 2 + 100 * u, oy = (H - S) / 2 + (phones ? 27 : 30) * u;   // the reference head top, in pixels
        const k = sp.offsetWidth / (sheet.cellW || 192);                                // sheet pixels to screen pixels
        const cx = sp.classList.contains("flip") ? (sheet.cellW || 192) - head[1] : head[1];
        const hx = sp.offsetLeft + cx * k, hy = sp.offsetTop + head[0] * k, hw = head[2] * k * (phones ? 0.74 : 1);
        acc.style.transformOrigin = `${ox}px ${oy}px`;
        acc.style.transform = `translate(${(hx - ox).toFixed(1)}px, ${(hy - oy).toFixed(1)}px) scale(${(hw / (96 * u)).toFixed(3)})`;
        // Sweat, z's and steam around the head, never so small they cannot be seen.
        const fy = (H - S) / 2 + 30 * u, fs = Math.max(0.6, head[2] * k / (96 * u));
        fx.style.transformOrigin = `${ox}px ${fy}px`;
        fx.style.transform = `translate(${(hx - ox).toFixed(1)}px, ${(hy - fy).toFixed(1)}px) scale(${fs.toFixed(3)})`;
    }

    // Returns false while the sheet is not loaded, so the drawn pet shows instead.
    function showSheet(url) {
        if (url !== sheet.url) {
            sheet.url = url; sheet.rows = 0; sheet.heads = null;
            const probe = new Image();
            probe.onload = () => {
                if (sheet.url !== url) return;
                const cell = probe.naturalWidth / 8 * 208 / 192;
                sheet.rows = Math.max(1, Math.round(probe.naturalHeight / cell));
                $("sprite").style.backgroundImage = `url(${JSON.stringify(url)})`;
                $("sprite").style.backgroundSize = `800% ${sheet.rows * 100}%`;
                sheet.cellW = probe.naturalWidth / 8;
                try { sheet.heads = measureHeads(probe); } catch (_) { sheet.heads = null; }
                showPet();
            };
            probe.onerror = () => { broken.add(url); showPet(); };
            probe.src = url;
            return false;
        }
        if (!sheet.rows) return false;
        if (!sheet.timer) { sheet.row = -1; spriteStep(); sheet.timer = setInterval(spriteStep, 140); }
        return true;
    }

    function stopSheet() { clearInterval(sheet.timer); sheet.timer = 0; }

    const KINDS = ["bit", "claude", "ghost", "robot", "slime", "clawd", "grace", "sealion", "jennie", "claire", "dario", "tom", "patrick", "pepe", "rick", "doge", "elon", "kirby", "clippy", "tux", "frieren", "anya", "miku", "luffy", "goku", "gojo", "umaru", "asuka", "doraemon", "elaina", "violet", "bocchi", "xiaohei", "sama", "doro", "guga", "kiki", "usagi", "hachiware", "custom"];
    // Pixel pets shipped with the widget, Codex pet sheets drawn by the author.
    const BUILTIN = { clawd: "./pet-clawd.webp", grace: "./pet-grace.webp", sealion: "./pet-sealion.webp", jennie: "./pet-jennie.webp", claire: "./pet-claire.webp", dario: "./pet-dario.webp", tom: "./pet-tom.webp", patrick: "./pet-patrick.webp", pepe: "./pet-pepe.webp", rick: "./pet-rick.webp", doge: "./pet-doge.webp", elon: "./pet-elon.webp", kirby: "./pet-kirby.webp", clippy: "./pet-clippy.webp", tux: "./pet-tux.webp", frieren: "./pet-frieren.webp", anya: "./pet-anya.webp", miku: "./pet-miku.webp", luffy: "./pet-luffy.webp", goku: "./pet-goku.webp", gojo: "./pet-gojo.webp", umaru: "./pet-umaru.webp", asuka: "./pet-asuka.webp", doraemon: "./pet-doraemon.webp", elaina: "./pet-elaina.webp", violet: "./pet-violet.webp", bocchi: "./pet-bocchi.webp", xiaohei: "./pet-xiaohei.webp", sama: "./pet-sama.webp", doro: "./pet-doro.webp", guga: "./pet-guga.webp", kiki: "./pet-kiki.webp", usagi: "./pet-usagi.webp", hachiware: "./pet-hachiware.webp" };

    // ponytail: pictures and sheets are fitted whole in the pet's place; iCUE's scale, position and angle are not applied.
    function showPet() {
        const mood = state.mood || "calm";
        const pick = name => { const u = mediaUrl(window[name]); return u && !broken.has(u) ? u : ""; };
        const chosen = KINDS.includes(String(window.petKind)) ? String(window.petKind) : "bit";
        let kind = chosen;
        const url = kind === "custom" ? pick(MEDIA[mood]) || pick(MEDIA.calm) : "";
        // The shipped pixel pets play as a sheet; the drawn Bit shows until it is loaded.
        if (BUILTIN[chosen]) kind = showSheet(BUILTIN[chosen]) ? "codex" : "bit";
        if (kind !== "codex") stopSheet();
        if (kind === "custom" && !url) kind = "bit";
        $("widget").dataset.pet = kind;
        $("widget").dataset.sheet = kind === "codex" ? chosen : "";   // which pixel pet, to fit hats and headphones on its head
        if (kind !== "codex") fitAccessory();   // a drawn pet: hats, sweat and z's back to their own place
        $("widget").classList.toggle("custom", kind === "custom" || kind === "codex");
        const img = $("petImg"), vid = $("petVid");
        const isVideo = VIDEO.test(url.split("?")[0]);
        const el = isVideo ? vid : img, other = isVideo ? img : vid;
        other.hidden = true;
        if (other === vid && vid.getAttribute("src")) { vid.pause(); vid.removeAttribute("src"); vid.load(); }
        if (!url) { img.hidden = true; img.removeAttribute("src"); return; }
        el.hidden = false;
        if (el.getAttribute("src") !== url) {
            el.onerror = () => { broken.add(url); showPet(); };
            el.setAttribute("src", url);
            if (isVideo) vid.play().catch(() => {});
        }
    }

    // ---------- One-off reactions ----------
    function react(row, cls, ms) {
        action.row = row; action.until = Date.now() + ms;
        const w = $("widget");
        w.classList.remove("hop", "wave");
        void w.offsetWidth;   // restarts the CSS animation
        w.classList.add(cls);
        setTimeout(() => { if (Date.now() >= action.until) w.classList.remove(cls); }, ms + 20);
    }

    function heart() {
        const h = document.createElement("span");
        h.className = "heart";
        h.textContent = "♥";
        h.style.left = `calc(50% + ${walk.x}px)`;
        $("stage").append(h);
        setTimeout(() => h.remove(), 1300);
    }

    // ---------- Walking about: wide slots only ----------
    function room() {
        const r = $("stage").getBoundingClientRect();
        // The pet takes about the stage's height; what is left on each side is where it can go.
        return Math.max(0, (r.width - r.height * 0.85) / 2);
    }

    function walkTo(target, speedUp, onArrive) {
        const speed = $("stage").clientHeight * 0.32 * persona().speed * speedUp;   // px per second
        const secs = Math.max(0.2, Math.abs(target - walk.x) / speed);
        walk.dir = target > walk.x ? 1 : -1;
        walk.moving = true;
        walk.x = target;
        walk.onArrive = onArrive || null;
        const w = $("walker");
        w.style.transition = `transform ${secs.toFixed(2)}s linear`;
        w.style.transform = `translateX(${target}px)`;
        $("widget").classList.add("walking");
        $("widget").classList.toggle("facing-left", walk.dir < 0);
        clearTimeout(walk.timer);
        walk.timer = setTimeout(() => {
            walk.moving = false;
            $("widget").classList.remove("walking");
            walk.next = Date.now() + (4000 + Math.random() * 8000) * persona().pause;
            const done = walk.onArrive;
            walk.onArrive = null;
            if (done) done();
        }, secs * 1000);
    }

    function roam() {
        const free = room();
        if (walk.moving) return;
        if (Math.abs(walk.x) > free) walk.x = Math.sign(walk.x) * free;   // the slot got smaller
        const can = !still && free > 40 && !state.need && (state.mood === "calm" || state.mood === "warm") && Date.now() >= action.until;
        if (!can || Date.now() < walk.next) { $("walker").style.transform = `translateX(${walk.x}px)`; return; }
        const target = (Math.random() * 2 - 1) * free;
        if (Math.abs(target - walk.x) < free * 0.2) { walk.next = Date.now() + 2000; return; }
        walkTo(target, state.mood === "warm" ? 1.5 : 1);
    }

    // ---------- Touch: a tap says hello, a swipe throws a ball ----------
    let press = null;
    $("stage").addEventListener("pointerdown", e => { press = { x: e.clientX, y: e.clientY, t: Date.now() }; });
    $("stage").addEventListener("pointerup", e => {
        if (!press) return;
        const dx = e.clientX - press.x, dy = e.clientY - press.y;
        press = null;
        if (Math.hypot(dx, dy) > 40) throwBall(dx); else tap();
    });

    function tap() {
        react(3, $("widget").dataset.pet === "codex" ? "wave" : "hop", 1100);
        heart();
        life.joy = clamp(life.joy + 6, 0, 100);
        life.day.taps++;
        if (life.day.taps <= 20) gain(3);
        shout("tap", 3000);
        live(Date.now());
    }

    let fetching = false;
    function throwBall(dx) {
        if (fetching) return;
        fetching = true;
        const free = room();
        const land = clamp(walk.x + dx * 1.6, -free, free);
        const ball = $("ball");
        ball.style.setProperty("--from", `${walk.x}px`);
        ball.style.setProperty("--to", `${land}px`);
        ball.classList.remove("thrown", "held");
        void ball.offsetWidth;
        ball.classList.add("thrown");
        const fetched = () => {
            ball.classList.remove("thrown");
            react(4, "hop", 1000);
            life.joy = clamp(life.joy + 12, 0, 100);
            life.day.fetches++;
            gain(10);
            shout("fetch", 4000);
            heart();
            fetching = false;
            live(Date.now());
        };
        // The pet runs after the ball once it has landed; in a narrow slot it only jumps for it.
        setTimeout(() => {
            if (free < 40 || still) fetched();
            else walkTo(land, 2.4, fetched);
        }, 750);
    }

    // ---------- The room: time of day and the weather of the city (Open-Meteo) ----------
    const fall = $("fall");
    for (let i = 0; i < 26; i++) {
        const d = document.createElement("i");
        d.style.left = `${(i * 37) % 100}%`;
        d.style.animationDelay = `${-(i * 0.37) % 1.6}s`;
        d.style.animationDuration = `${0.7 + (i % 5) * 0.12}s`;
        fall.append(d);
    }
    const weather = { key: "", code: -1, day: true, at: 0, request: null };
    function sky() {
        const h = new Date().getHours();
        return !weather.day || h >= 21 || h < 6 ? "night" : h >= 18 || h < 8 ? "dusk" : "day";
    }
    function wxFor(code) {
        if (code < 0) return "clear";
        if (code >= 95) return "storm";
        if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
        if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
        if (code === 45 || code === 48) return "fog";
        return code >= 2 ? "cloudy" : "clear";
    }
    async function updateWeather() {
        const on = flag("roomWeather", true);
        $("room").hidden = !on;
        if (!on) return;
        const demo = new URLSearchParams(location.search).get("wx");
        if (DEMO || demo) { weather.code = { rain: 61, snow: 71, storm: 95, cloudy: 3, fog: 45 }[demo] || 0; weather.day = !isNight(); }
        else {
            const city = setting("weatherCity", "Paris");
            if (city !== weather.key || Date.now() - weather.at > 15 * 60000) {
                weather.key = city; weather.at = Date.now();
                if (weather.request) weather.request.abort();
                weather.request = new AbortController();
                try {
                    const geo = (await WidgetRuntime.requestJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`, { signal: weather.request.signal })).data;
                    const loc = geo.results && geo.results[0];
                    if (loc) {
                        const cur = (await WidgetRuntime.requestJson(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=weather_code,is_day&timezone=auto`, { signal: weather.request.signal })).data.current;
                        if (cur) { weather.code = cur.weather_code; weather.day = cur.is_day !== 0; }
                    }
                } catch (_) { weather.at = Date.now() - 13 * 60000; /* try again in about 2 min */ }
            }
        }
        $("room").dataset.sky = sky();
        $("room").dataset.wx = wxFor(weather.code);
    }

    // ---------- Music and Claude Code, through the companion ----------
    const pc = { music: "", artist: "", claude: "" };
    // Video sites add tags to music titles: "(Official Video)", "[Lyrics]", "LISAVEVO", "LISA - Topic".
    const TAG = /\s*[\(\[][^\)\]]*(official|video|audio|lyric|visuali[sz]er|\bmv\b|\bhd\b|4k|remaster)[^\)\]]*[\)\]]/gi;
    function cleanSong(title, artist) {
        let song = String(title || "").replace(TAG, "").trim();
        let who = String(artist || "").replace(/vevo$/i, "").replace(/\s+-\s+topic$/i, "").replace(/\s+official$/i, "").trim();
        // "LISA - Tarantino" from a channel: the part before the dash is the artist.
        const dash = song.match(/^(.+?)\s+[-–—]\s+(.+)$/);
        if (dash && (!who || dash[1].toLowerCase().includes(who.toLowerCase()) || who.toLowerCase().includes(dash[1].toLowerCase()))) { who = dash[1].trim(); song = dash[2].trim(); }
        return [song.slice(0, 40), who.slice(0, 30)];
    }
    // Each new song is named and praised once; the same song again within 30 min is not.
    const heard = { key: "", at: {} };
    function noteSong() {
        const key = pc.music ? `${pc.artist}|${pc.music}`.toLowerCase() : "";
        if (key === heard.key) return;
        heard.key = key;
        const now = Date.now();
        for (const k of Object.keys(heard.at)) if (now - heard.at[k] > 30 * 60000) delete heard.at[k];
        if (!key || heard.at[key]) return;
        heard.at[key] = now;
        life.day.songs = (life.day.songs || 0) + 1;
        let fav = false;
        const who = pc.artist.toLowerCase();
        if (who) {
            life.artists = life.artists || {};
            life.artists[who] = (life.artists[who] || 0) + 1;
            fav = life.artists[who] >= 3;
            // Only the 60 most played artists are kept.
            const names = Object.keys(life.artists);
            if (names.length > 60) names.sort((a, b) => life.artists[a] - life.artists[b]).slice(0, names.length - 60).forEach(n => delete life.artists[n]);
        }
        Object.assign(state.vars, { song: pc.music, artist: pc.artist });
        shout(fav ? "fav" : "taste", 7000);
        heart();
        if (life.day.songs <= 30) gain(2);
        live(now);
    }
    async function updateCompanion() {
        if (preview.on) return;   // the preview scene sets the music and Claude Code
        if (DEMO) { const d = new URLSearchParams(location.search).get("demo"); pc.music = d === "music" ? "Midnight City" : ""; pc.artist = d === "music" ? "M83" : ""; pc.claude = d === "claude" ? "editing" : ""; noteSong(); return; }
        if (!flag("petCompanion", true)) { pc.music = pc.artist = pc.claude = ""; return; }
        try {
            const media = (await WidgetRuntime.requestJson(`${ENDPOINT}/api/media/state`)).data;
            // The shown session has the artist; any other playing one only its title.
            const shown = media && media.session && media.session.playback === "playing" ? media.session : null;
            const playing = shown || (media && (media.sessions || []).find(s => s.playback === "playing"));
            [pc.music, pc.artist] = playing ? cleanSong(playing.title || "this song", shown ? shown.artist : "") : ["", ""];
        } catch (_) { pc.music = pc.artist = ""; }
        noteSong();
        try {
            const agent = (await WidgetRuntime.requestJson(`${ENDPOINT}/api/agent/state`)).data;
            pc.claude = agent && agent.active ? (agent.step && agent.step.verb ? String(agent.step.verb).toLowerCase() : "working") : "";
        } catch (_) { pc.claude = ""; }
    }

    // ---------- Preview mode: every state in turn, without heating the PC or touching the pet's real stats ----------
    const SCENES = [
        { label: "Calm", t: 52, l: 20 },
        { label: "Walking", t: 55, l: 25, act: "walk" },
        { label: "Warm", t: 74, l: 60 },
        { label: "Hot", t: 88, l: 95 },
        { label: "Cooled down", t: 50, l: 15 },
        { label: "Sleepy", t: 40, l: 3 },
        { label: "Music", t: 52, l: 20, music: "Midnight City", artist: "M83" },
        { label: "Claude Code", t: 55, l: 30, claude: "editing" },
        { label: "Gaming", t: 62, l: 80, fps: 144 },
        { label: "Tap", t: 52, l: 20, act: "tap" },
        { label: "Ball", t: 52, l: 20, act: "ball" },
        { label: "Tired", t: 52, l: 20, need: "tired" },
        { label: "Sulking", t: 52, l: 20, need: "sulk" },
        { label: "Bow (level 4)", t: 52, l: 20, hat: "bow" },
        { label: "Wizard hat (level 6)", t: 52, l: 20, hat: "wizard" },
        { label: "Crown (level 10)", t: 52, l: 20, hat: "crown" },
    ];
    const SCENE_MS = 6000;
    const scene = () => SCENES[preview.i];
    function previewTick() {
        const on = flag("petPreview", false);
        if (on !== preview.on) {
            preview.on = on;
            if (on) { preview.kept = JSON.stringify(life); preview.i = -1; preview.at = 0; }
            else { Object.assign(life, JSON.parse(preview.kept)); pc.music = pc.claude = ""; updateCompanion(); live(Date.now()); }
        }
        if (!on || Date.now() - preview.at < SCENE_MS) return;
        preview.i = (preview.i + 1) % SCENES.length;
        preview.at = Date.now();
        const s = scene();
        pc.music = s.music || ""; pc.artist = s.artist || ""; pc.claude = s.claude || "";
        state.sayUntil = state.lineAt = 0;   // a fresh line for each scene
        if (s.act === "tap") tap();
        if (s.act === "ball") throwBall(room() > 40 ? (walk.x > 0 ? -1 : 1) * room() * 0.5 : 60);
        if (s.act === "walk" && room() > 40 && !walk.moving) walkTo(walk.x > 0 ? -room() * 0.8 : room() * 0.8, 1);
        live(Date.now());
        noteSong();
    }
    function previewReading() {
        const s = scene(), c = v => ({ value: v, units: "°C", name: "Preview" }), p = v => ({ value: v, units: "%", name: "Preview" });
        return { plugin: true, cpuTemp: c(s.t), gpuTemp: c(s.t - 6), cpuLoad: p(s.l), gpuLoad: p(Math.max(1, s.l - 10)), fps: s.fps ? { value: s.fps, units: "FPS" } : null };
    }

    // ---------- Readings ----------
    function render(r) {
        if (preview.on && preview.i >= 0) r = previewReading();
        $("name").textContent = petName();
        const now = Date.now();
        if (r.plugin === false) {
            state.mood = "sleepy";
            $("widget").dataset.mood = "sleepy";
            showPet();
            $("say").textContent = "Waiting for iCUE sensors";
            $("overlayTitle").textContent = "iCUE sensors not available";
            $("overlaySub").textContent = "This pet lives on the iCUE Sensors plugin; it wakes up on the XENEON EDGE inside iCUE.";
            $("overlay").classList.add("visible");
            return;
        }
        $("overlay").classList.remove("visible");
        const temps = [["CPU", r.cpuTemp], ["GPU", r.gpuTemp]].map(([n, x]) => [n, x, celsius(x)]).filter(x => Number.isFinite(x[2]));
        const loads = [r.cpuLoad, r.gpuLoad].filter(Boolean).map(x => x.value);
        const hottest = temps.sort((a, b) => b[2] - a[2])[0];
        const t = hottest ? hottest[2] : NaN, l = loads.length ? Math.max(...loads) : 0;
        $("cpu").textContent = deg(r.cpuTemp) || "--";
        $("gpu").textContent = deg(r.gpuTemp) || "--";
        $("load").textContent = loads.length ? `${Math.round(l)}%` : "--";
        if (!Number.isFinite(t)) {
            state.mood = "calm";
            $("widget").dataset.mood = "calm";
            showPet();
            $("say").textContent = "I can't feel any temperature sensor in iCUE.";
            return;
        }
        life.day.max = Math.max(life.day.max, t);
        const fps = r.fps && r.fps.value >= 1 ? Math.round(r.fps.value) : 0;
        state.activity = fps ? "game" : pc.claude ? "claude" : pc.music ? "music" : "";
        $("widget").dataset.activity = state.activity;

        const warm = clamp(num("warmAt", 70), 40, 100), hot = Math.max(warm + 4, clamp(num("hotAt", 82), 44, 110));
        const prev = state.mood;
        const mood = moodFor(t, l, prev, warm, hot, isNight());
        state.vars = {
            cpu: deg(r.cpuTemp), gpu: deg(r.gpuTemp), hot: `${hottest[0]} at ${deg(hottest[1])}`, load: loads.length ? `${Math.round(l)}%` : "",
            for: now - state.since >= 60000 ? span(now - state.since) : "", fps: fps ? String(fps) : "", song: pc.music, artist: pc.artist, verb: pc.claude,
            level: String(levelFor(life.xp)), time: new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
        };
        if (mood !== prev) {
            state.mood = mood;
            state.since = now;
            $("widget").dataset.mood = mood;
            showPet();
            if ((prev === "warm" || prev === "hot") && (mood === "calm" || mood === "sleepy")) {
                react(4, "hop", 1200);   // a jump for joy when it cools down
                shout("cooled", 6000);
            } else if (Date.now() >= state.sayUntil) say(mood, true);   // a song or a tap just spoke: let it finish
        } else {
            // Heat first, then needs, then what the PC is doing, then the plain mood.
            const pool = mood === "hot" ? "hot" : state.need || state.activity || (mood === "sleepy" && isNight() ? "night" : mood);
            say(pool);
        }
        live(now);
        // Breathes faster the busier the PC is: 4 s at rest, 1.2 s flat out.
        $("widget").style.setProperty("--breath", `${(4 - Math.min(100, l) / 100 * 2.8).toFixed(2)}s`);
    }

    // iCUE can change a setting without sending an event: the pet's settings are compared three times a second.
    let shown = "";
    function settingsChanged() {
        const key = JSON.stringify([window.petKind, window.petName, window.petAccessory, window.roomWeather, window.weatherCity, ...Object.values(MEDIA).map(n => mediaUrl(window[n]))]);
        if (key === shown) return;
        shown = key;
        $("name").textContent = petName();
        showPet();
        updateWeather();
        live(Date.now());
    }

    window.RigPet = { moodFor, levelFor, cleanSong };
    window.icueEvents = { onICUEInitialized: settingsChanged, onDataUpdated: settingsChanged };
    // The shipped sheets are loaded once at start, so switching mascot is instant.
    Object.values(BUILTIN).forEach(u => { new Image().src = u; });
    addEventListener("pagehide", () => store.write(preview.on ? JSON.parse(preview.kept) : life));
    setInterval(settingsChanged, 300);
    setInterval(previewTick, 500);
    setInterval(roam, 1000);
    setInterval(updateWeather, 60000);
    setInterval(updateCompanion, 10000);
    updateCompanion();
    SensorReader.watch(render);
})();
