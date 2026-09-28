/* jshint esversion: 11 */
'use strict';

function syncIssHorizonMapStyle() {
    if (window.IssHorizonIcue && typeof window.IssHorizonIcue.syncMapStyle === 'function') {
        window.IssHorizonIcue.syncMapStyle();
    }
}

window.icueEvents = {
    onICUEInitialized: syncIssHorizonMapStyle,
    onDataUpdated: syncIssHorizonMapStyle
};

window.addEventListener('DOMContentLoaded', syncIssHorizonMapStyle);
