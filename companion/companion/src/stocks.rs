//! Stocks widget: quotes from Yahoo Finance's chart endpoint (unofficial, no key). Only the symbols
//! the widget asks for are sent; each one is fetched at most once a minute, and a failure keeps the
//! last good quote marked stale.
use crate::util::{now_ms, read_limited, MIN};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

const MAX_SYMBOLS: usize = 8;
const FRESH_MS: u64 = MIN;
const MAX_CACHED: usize = 64;

/// symbol -> (fetched at, quote, last attempt failed)
static CACHE: LazyLock<Mutex<HashMap<String, (u64, Value, bool)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Ticker symbols as Yahoo writes them: letters, digits and . ^ = - (AAPL, BRK-B, ^GSPC, EURUSD=X, MC.PA).
pub fn valid_symbol(s: &str) -> bool {
    (1..=12).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '^' | '=' | '-')) && s.chars().any(|c| c.is_ascii_alphanumeric())
}

pub fn parse_list(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in raw.split(',').map(|s| s.trim().to_ascii_uppercase()).filter(|s| valid_symbol(s)) {
        if !out.contains(&s) && out.len() < MAX_SYMBOLS {
            out.push(s);
        }
    }
    out
}

/// One quote from a `/v8/finance/chart` answer: last price, change against the previous close,
/// the day's figures and the intraday closes. None when the answer has no price.
pub fn parse_chart(v: &Value, now_s: u64) -> Option<Value> {
    let r = v.pointer("/chart/result/0")?;
    let m = r.get("meta")?;
    let price = m.get("regularMarketPrice")?.as_f64()?;
    let prev = m.get("chartPreviousClose").or(m.get("previousClose")).and_then(Value::as_f64).unwrap_or(price);
    let closes: Vec<f64> = r.pointer("/indicators/quote/0/close").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_f64).collect()).unwrap_or_default();
    let open = r.pointer("/indicators/quote/0/open/0").and_then(Value::as_f64).or(closes.first().copied());
    let period = m.pointer("/currentTradingPeriod/regular");
    let (start, end) = (period.and_then(|p| p["start"].as_u64()).unwrap_or(0), period.and_then(|p| p["end"].as_u64()).unwrap_or(0));
    let s = |k: &str| m.get(k).and_then(Value::as_str);
    Some(json!({
        "symbol": s("symbol"),
        "name": s("shortName").or(s("longName")),
        "currency": s("currency"),
        "exchange": s("fullExchangeName").or(s("exchangeName")),
        "price": price,
        "prevClose": prev,
        "change": price - prev,
        "changePct": if prev != 0.0 { (price - prev) / prev * 100.0 } else { 0.0 },
        "open": open,
        "high": m.get("regularMarketDayHigh").and_then(Value::as_f64),
        "low": m.get("regularMarketDayLow").and_then(Value::as_f64),
        "volume": m.get("regularMarketVolume").and_then(Value::as_u64),
        "time": m.get("regularMarketTime").and_then(Value::as_u64).map(|t| t * 1000),
        "marketOpen": start <= now_s && now_s < end,
        "points": closes,
    }))
}

fn fetch(symbol: &str) -> Option<Value> {
    let url = format!("https://query1.finance.yahoo.com/v8/finance/chart/{}?range=1d&interval=5m", crate::spotify::auth::percent(symbol));
    let r = ureq::AgentBuilder::new().redirects(0).timeout(Duration::from_secs(6)).build().get(&url).set("User-Agent", "icue-edge-companion (XENEON EDGE widget)").call().ok()?;
    let body: Value = serde_json::from_slice(&read_limited(r.into_reader(), 512 * 1024).ok()?).ok()?;
    parse_chart(&body, now_ms() / 1000)
}

/// The `stocks/1` snapshot for the asked symbols, refreshing those older than a minute.
pub fn snapshot(raw: &str) -> Value {
    let symbols = parse_list(raw);
    let now = now_ms();
    for sym in &symbols {
        let stale = CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(sym).is_none_or(|(at, ..)| at + FRESH_MS < now);
        if stale {
            let got = fetch(sym);
            let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
            if cache.len() >= MAX_CACHED && !cache.contains_key(sym) {
                if let Some(oldest) = cache.iter().min_by_key(|(_, (at, ..))| *at).map(|(k, _)| k.clone()) {
                    cache.remove(&oldest);
                }
            }
            match got {
                Some(q) => { cache.insert(sym.clone(), (now, q, false)); }
                // Keep the last good quote, marked stale; retry in a minute.
                None => { let e = cache.entry(sym.clone()).or_insert((now, json!({ "symbol": sym }), true)); e.0 = now; e.2 = true; }
            }
        }
    }
    let cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    json!({
        "schema": "stocks/1",
        "source": "Yahoo Finance (unofficial)",
        "quotes": symbols.iter().filter_map(|s| cache.get(s)).map(|(at, q, failed)| {
            let mut q = q.clone();
            q["stale"] = json!(*failed);
            q["fetchedAt"] = json!(at);
            q
        }).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Calls Yahoo Finance: `cargo test -- --ignored live_quote`.
    #[test]
    #[ignore]
    fn live_quote() {
        let s = snapshot("AAPL,^GSPC");
        eprintln!("{}", serde_json::to_string(&s["quotes"].as_array().unwrap().iter().map(|q| json!([q["symbol"], q["price"], q["changePct"], q["points"].as_array().map(|p| p.len()), q["stale"]])).collect::<Vec<_>>()).unwrap());
        assert_eq!(s["quotes"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn symbols_are_checked_and_capped() {
        assert_eq!(parse_list(" aapl, NVDA ,^gspc,brk-b,eurusd=x, mc.pa ,AAPL"), ["AAPL", "NVDA", "^GSPC", "BRK-B", "EURUSD=X", "MC.PA"]);
        assert!(parse_list("../etc,a b,<x>,toolongsymbol1").is_empty());
        assert!(!valid_symbol(".") && !valid_symbol("..") && !valid_symbol("^=-"));
        assert!(valid_symbol("BRK.B"));
        assert_eq!(parse_list("A,B,C,D,E,F,G,H,I,J").len(), MAX_SYMBOLS);
    }

    #[test]
    fn chart_answer_becomes_a_quote() {
        let v = json!({ "chart": { "result": [{ "meta": { "symbol": "AAPL", "shortName": "Apple Inc.", "currency": "USD", "fullExchangeName": "NasdaqGS",
            "regularMarketPrice": 110.0, "chartPreviousClose": 100.0, "regularMarketDayHigh": 112.0, "regularMarketDayLow": 99.0, "regularMarketVolume": 5,
            "regularMarketTime": 1000, "currentTradingPeriod": { "regular": { "start": 900, "end": 2000 } } },
            "indicators": { "quote": [{ "open": [101.0], "close": [101.0, null, 110.0] }] } }] } });
        let q = parse_chart(&v, 1500).unwrap();
        assert_eq!((q["change"].as_f64(), q["changePct"].as_f64()), (Some(10.0), Some(10.0)));
        assert_eq!(q["points"], json!([101.0, 110.0]));
        assert_eq!((q["marketOpen"].as_bool(), q["time"].as_u64()), (Some(true), Some(1_000_000)));
        assert!(parse_chart(&json!({ "chart": { "result": null } }), 0).is_none());
    }
}
