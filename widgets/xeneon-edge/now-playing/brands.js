// Marks for the players shown in the source chip, keyed by the name the companion reports.
// Zen comes from the logo file you supplied; the others are simplified drawings, not official brand files:
// to use an official logo, replace its <svg> string.
// A player without an entry keeps the plain status dot.
(() => {
    "use strict";

    const svg = body => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
    const BRANDS = {
        spotify: svg('<circle cx="12" cy="12" r="12" fill="#1DB954"/><g fill="none" stroke="#000" stroke-linecap="round"><path d="M5.400 9.100Q12 6.900 18.700 10.400" stroke-width="2"/><path d="M6.300 12.700Q12 10.900 17.600 13.700" stroke-width="1.700"/><path d="M7.100 16Q12 14.500 16.500 16.700" stroke-width="1.400"/></g>'),
        chrome: svg('<path d="M12 12 1.610 6A12 12 0 0 1 22.390 6Z" fill="#EA4335"/><path d="M12 12 22.390 6A12 12 0 0 1 12 24Z" fill="#FBBC05"/><path d="M12 12V24A12 12 0 0 1 1.610 6Z" fill="#34A853"/><circle cx="12" cy="12" r="5.600" fill="#fff"/><circle cx="12" cy="12" r="4.200" fill="#4285F4"/>'),
        brave: svg('<path d="M12 1.200 19.600 3.800 22.200 9.400 20.400 17.400 12 22.800 3.600 17.400 1.800 9.400 4.400 3.800Z" fill="#FB542B"/><path d="M12 6.600 15.800 8 17.700 11.400 12 17.400 6.300 11.400 8.200 8Z" fill="#fff"/><path d="M12 9.800 14 11.300 12 14.600 10 11.300Z" fill="#FB542B"/>'),
        firefox: svg('<defs><linearGradient id="ff" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#FF3B30"/><stop offset="1" stop-color="#FFB000"/></linearGradient></defs><circle cx="12" cy="12" r="11.500" fill="url(#ff)"/><circle cx="10.800" cy="10.800" r="7.800" fill="#6E3FD8"/><path d="M10.800 3c4.600 0 8 3.400 8 8-1.200-2.600-3.400-3.800-5.800-3.600 1.200 1.200 1.400 2.400 1 3.800-1.400-1.600-3.200-2-5-1.400 2 .4 3 1.600 3 3.200 0 1.800-1.600 2.800-3.600 2.400C6.300 14.600 4.200 12.800 4.200 9.800 4.200 6 7 3 10.800 3z" fill="#FF9F0A" opacity=".85"/>'),
        zen: '<svg viewBox="0 0 64 64" aria-hidden="true" fill="#F47152"><path fill-rule="evenodd" d="M32 44.3077C38.7974 44.3077 44.3077 38.7974 44.3077 32C44.3077 25.2027 38.7974 19.6923 32 19.6923C25.2027 19.6923 19.6923 25.2027 19.6923 32C19.6923 38.7974 25.2027 44.3077 32 44.3077ZM41.8462 32C41.8462 37.4379 37.4379 41.8462 32 41.8462C26.5621 41.8462 22.1538 37.4379 22.1538 32C22.1538 26.5621 26.5621 22.1538 32 22.1538C37.4379 22.1538 41.8462 26.5621 41.8462 32Z"/><path fill-rule="evenodd" d="M53.3333 32C53.3333 43.7821 43.7821 53.3333 32 53.3333C20.2179 53.3333 10.6667 43.7821 10.6667 32C10.6667 20.2179 20.2179 10.6667 32 10.6667C43.7821 10.6667 53.3333 20.2179 53.3333 32ZM32 49.2308C41.5163 49.2308 49.2308 41.5163 49.2308 32C49.2308 22.4837 41.5163 14.7692 32 14.7692C22.4837 14.7692 14.7692 22.4837 14.7692 32C14.7692 41.5163 22.4837 49.2308 32 49.2308Z"/><path fill-rule="evenodd" d="M64 32C64 49.6731 49.6731 64 32 64C14.3269 64 0 49.6731 0 32C0 14.3269 14.3269 0 32 0C49.6731 0 64 14.3269 64 32ZM32 58.2564C46.501 58.2564 58.2564 46.501 58.2564 32C58.2564 17.499 46.501 5.74359 32 5.74359C17.499 5.74359 5.74359 17.499 5.74359 32C5.74359 46.501 17.499 58.2564 32 58.2564Z"/></svg>',
        edge: svg('<defs><linearGradient id="eg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1B6FD8"/><stop offset="1" stop-color="#3DDC97"/></linearGradient></defs><circle cx="12" cy="12" r="11.500" fill="url(#eg)"/><path d="M4.600 13.400C4.800 8.600 8.600 5.400 12.600 5.400c3.800 0 6.400 2.500 6.400 5.800 0 2.300-1.900 3.400-3.900 3.400H8.800c.2 2.700 2.600 4.200 5.400 4.200 1.700 0 3.100-.4 4.400-1.300-1.400 2.200-3.800 3.500-6.700 3.500-4.100 0-7.100-2.800-7.300-6.600z" fill="#fff" opacity=".9"/>'),
        opera: svg('<path fill-rule="evenodd" d="M12 .5a11.500 11.500 0 1 0 0 23 11.500 11.500 0 0 0 0-23zm0 3c-2.600 0-4.200 3.700-4.200 8.500s1.600 8.500 4.200 8.500 4.200-3.700 4.200-8.500S14.600 3.500 12 3.500z" fill="#FF1B2D"/>'),
        vivaldi: svg('<circle cx="12" cy="12" r="11.500" fill="#EF3939"/><path d="M6.200 8.200 10.400 16c.4.800 1.600.800 2 0l5.400-9.800" fill="none" stroke="#fff" stroke-width="2.400" stroke-linecap="round" stroke-linejoin="round"/>'),
        vlc: svg('<path d="M12 2 18.200 18H5.800Z" fill="#FF8800"/><path d="M9.900 7.600h4.200l.9 2.400H9zM8.100 12.600h7.800l.9 2.400H7.200z" fill="#fff"/><path d="M3.500 19.400h17v2.600h-17z" fill="#FF8800"/>'),
    };

    const ALIASES = [
        [/spotify/i, "spotify"], [/chrome|chromium/i, "chrome"], [/brave/i, "brave"], [/zen/i, "zen"],
        [/firefox/i, "firefox"], [/edge/i, "edge"], [/opera/i, "opera"], [/vivaldi/i, "vivaldi"], [/vlc/i, "vlc"],
    ];

    window.brandLogo = name => {
        const hit = ALIASES.find(([re]) => re.test(name || ""));
        return hit ? BRANDS[hit[1]] : null;
    };
})();
