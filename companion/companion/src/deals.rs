//! Free Games & Deals widget: this week's free games on the Epic Games Store and the price of the Steam
//! games the user lists (public store endpoints, no key). Only the country code and the listed Steam app
//! ids are sent. Each answer is cached for an hour; a failure keeps the last good one, marked stale.
use crate::util::{now_ms, read_limited, MIN};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

const FRESH_MS: u64 = 60 * MIN;
const RETRY_MS: u64 = 5 * MIN;
const MAX_APPS: usize = 10;
/// Image hosts the widget may load from (its page allows only these).
const IMAGE_HOSTS: &[&str] = &["https://cdn1.epicgames.com/", "https://cdn2.unrealengine.com/", "https://shared.akamai.steamstatic.com/", "https://cdn.akamai.steamstatic.com/"];

/// key ("epic:FR", "steam:FR:570") -> (fetched at, value, last attempt failed)
static CACHE: LazyLock<Mutex<HashMap<String, (u64, Value, bool)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn valid_country(cc: &str) -> bool {
    cc.len() == 2 && cc.chars().all(|c| c.is_ascii_uppercase())
}

/// Steam app ids: digits only, deduplicated, at most ten.
pub fn parse_apps(raw: &str) -> Vec<u32> {
    let mut out = Vec::new();
    for id in raw.split(',').filter_map(|s| s.trim().parse::<u32>().ok()).filter(|&n| n > 0) {
        if !out.contains(&id) && out.len() < MAX_APPS {
            out.push(id);
        }
    }
    out
}

fn allowed(u: &str) -> bool {
    IMAGE_HOSTS.iter().any(|h| u.starts_with(h)) && !u.contains(['"', '\'', '(', ')', ' ', '\\', '\n'])
}

/// A store image, as a path on this server: iCUE does not show internet images in widgets, so the
/// companion fetches them (see `image_bytes`).
fn image(url: Option<&str>) -> Option<String> {
    url.filter(|u| allowed(u)).map(|u| format!("/api/deals/image?u={}", crate::spotify::auth::percent(u)))
}

/// url -> (mime, bytes): the last 24 images, each fetched once.
static IMAGES: LazyLock<Mutex<Vec<(String, String, Vec<u8>)>>> = LazyLock::new(|| Mutex::new(Vec::new()));

/// The bytes of an allowed store image (2 MB at most), kept in memory.
pub fn image_bytes(url: &str) -> Option<(String, Vec<u8>)> {
    if !allowed(url) {
        return None;
    }
    if let Some((_, m, b)) = IMAGES.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|(u, ..)| u == url) {
        return Some((m.clone(), b.clone()));
    }
    let r = ureq::AgentBuilder::new().redirects(0).timeout(Duration::from_secs(8)).build().get(url).set("User-Agent", "icue-edge-companion (XENEON EDGE widget)").call().ok()?;
    let mime = r.content_type().to_string();
    if !matches!(mime.as_str(), "image/jpeg" | "image/png" | "image/webp" | "image/gif") {
        return None;
    }
    let bytes = read_limited(r.into_reader(), 2 * 1024 * 1024).ok()?;
    let mut cache = IMAGES.lock().unwrap_or_else(|e| e.into_inner());
    if cache.len() >= 24 {
        cache.remove(0);
    }
    cache.push((url.to_string(), mime.clone(), bytes.clone()));
    Some((mime, bytes))
}

fn offers<'a>(v: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    v.pointer(&format!("/promotions/{key}")).and_then(Value::as_array).into_iter().flatten()
        .filter_map(|g| g["promotionalOffers"].as_array()).flatten()
}

/// The free games of an Epic `freeGamesPromotions` answer: those free now, then those free next.
pub fn parse_epic(v: &Value) -> Value {
    let mut now = Vec::new();
    let mut next = Vec::new();
    for el in v.pointer("/data/Catalog/searchStore/elements").and_then(Value::as_array).into_iter().flatten() {
        let free = |o: &&Value| o.pointer("/discountSetting/discountPercentage").and_then(Value::as_u64) == Some(0);
        let slug = el.pointer("/catalogNs/mappings/0/pageSlug").and_then(Value::as_str).or(el["productSlug"].as_str()).unwrap_or("");
        let slug: String = slug.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
        let img = el["keyImages"].as_array().into_iter().flatten()
            .find(|k| k["type"] == "OfferImageWide").or_else(|| el["keyImages"].as_array().and_then(|a| a.iter().find(|k| k["type"] == "Thumbnail")))
            .and_then(|k| image(k["url"].as_str()));
        let base = |o: &Value| json!({
            "title": el["title"].as_str().unwrap_or("Free game"),
            "image": img,
            "url": if slug.is_empty() { Value::Null } else { json!(format!("https://store.epicgames.com/p/{slug}")) },
            "worth": el.pointer("/price/totalPrice/originalPrice").and_then(Value::as_u64),
            "currency": el.pointer("/price/totalPrice/currencyCode").and_then(Value::as_str),
            "start": o["startDate"].as_str(),
            "end": o["endDate"].as_str(),
        });
        if let Some(o) = offers(el, "promotionalOffers").find(free) {
            now.push(base(o));
        } else if let Some(o) = offers(el, "upcomingPromotionalOffers").find(free) {
            next.push(base(o));
        }
    }
    json!({ "now": now, "next": next })
}

/// One Steam game from an `appdetails` answer.
pub fn parse_steam(v: &Value, id: u32) -> Option<Value> {
    let d = v.pointer(&format!("/{id}/data"))?;
    let p = d.get("price_overview");
    Some(json!({
        "id": id,
        "name": d["name"].as_str()?,
        "image": image(d["header_image"].as_str()),
        "url": format!("https://store.steampowered.com/app/{id}"),
        "free": d["is_free"].as_bool().unwrap_or(false),
        "final": p.and_then(|p| p["final"].as_u64()),
        "initial": p.and_then(|p| p["initial"].as_u64()),
        "discount": p.and_then(|p| p["discount_percent"].as_u64()).unwrap_or(0),
        "currency": p.and_then(|p| p["currency"].as_str()),
    }))
}

pub(crate) fn get(url: &str) -> Option<Value> {
    let r = ureq::AgentBuilder::new().redirects(0).timeout(Duration::from_secs(8)).build().get(url).set("User-Agent", "icue-edge-companion (XENEON EDGE widget)").call().ok()?;
    serde_json::from_slice(&read_limited(r.into_reader(), 2 * 1024 * 1024).ok()?).ok()
}

/// Cached fetch: the last good value, refreshed once an hour; a failure is retried after 5 minutes.
pub(crate) fn cached(key: String, fetch: impl FnOnce() -> Option<Value>) -> Option<(u64, Value, bool)> {
    let now = now_ms();
    let fresh = CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(&key).is_some_and(|(at, _, failed)| at + if *failed { RETRY_MS } else { FRESH_MS } > now);
    if !fresh {
        let got = fetch();
        let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        match got {
            Some(v) => { cache.insert(key.clone(), (now, v, false)); }
            // A key that never answered is kept as Null, so each widget poll does not call out again.
            None => { let e = cache.entry(key.clone()).or_insert((now, Value::Null, true)); e.0 = now; e.2 = true; }
        }
    }
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(&key).filter(|(_, v, _)| !v.is_null()).cloned()
}

/// The `deals/1` snapshot.
pub fn snapshot(cc: &str, apps: &str) -> Value {
    let cc = if valid_country(cc) { cc } else { "US" };
    let epic = cached(format!("epic:{cc}"), || {
        get(&format!("https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country={cc}&allowCountries={cc}")).map(|v| parse_epic(&v))
    });
    let steam: Vec<Value> = parse_apps(apps).into_iter().filter_map(|id| {
        cached(format!("steam:{cc}:{id}"), || get(&format!("https://store.steampowered.com/api/appdetails?appids={id}&cc={cc}&l=en")).and_then(|v| parse_steam(&v, id)))
            .map(|(at, mut v, stale)| { v["stale"] = json!(stale); v["fetchedAt"] = json!(at); v })
    }).collect();
    json!({
        "schema": "deals/1",
        "epic": epic.as_ref().map(|(_, v, _)| v.clone()),
        "epicStale": epic.as_ref().is_none_or(|e| e.2),
        "steam": steam,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apps_and_countries_are_checked() {
        assert_eq!(parse_apps(" 570, 1245620,abc,570,-3,0"), [570, 1245620]);
        assert_eq!(parse_apps("1,2,3,4,5,6,7,8,9,10,11").len(), MAX_APPS);
        assert!(valid_country("FR") && !valid_country("fr") && !valid_country("FRA") && !valid_country("F&"));
    }

    #[test]
    fn epic_answer_splits_free_now_and_next() {
        let offer = |pct: u64| json!([{ "promotionalOffers": [{ "startDate": "2026-11-05T16:00:00.000Z", "endDate": "2026-11-12T16:00:00.000Z", "discountSetting": { "discountPercentage": pct } }] }]);
        let v = json!({ "data": { "Catalog": { "searchStore": { "elements": [
            { "title": "Now Free", "keyImages": [{ "type": "OfferImageWide", "url": "https://cdn1.epicgames.com/a.jpg" }], "catalogNs": { "mappings": [{ "pageSlug": "now-free" }] },
              "price": { "totalPrice": { "originalPrice": 1999, "currencyCode": "EUR" } }, "promotions": { "promotionalOffers": offer(0), "upcomingPromotionalOffers": [] } },
            { "title": "Next Free", "keyImages": [{ "type": "OfferImageWide", "url": "https://evil.example/x.jpg" }], "productSlug": "next/home",
              "promotions": { "promotionalOffers": [], "upcomingPromotionalOffers": offer(0) } },
            { "title": "Just Cheaper", "keyImages": [], "promotions": { "promotionalOffers": offer(60) } },
            { "title": "No Promo", "keyImages": [], "promotions": null },
        ] } } } });
        let r = parse_epic(&v);
        assert_eq!(r["now"][0]["title"], "Now Free");
        assert_eq!(r["now"][0]["url"], "https://store.epicgames.com/p/now-free");
        assert_eq!(r["now"][0]["worth"], 1999);
        assert_eq!(r["next"][0]["title"], "Next Free");
        assert_eq!(r["next"][0]["image"], Value::Null);   // not an allowed image host
        assert_eq!(r["now"][0]["image"], "/api/deals/image?u=https%3A%2F%2Fcdn1.epicgames.com%2Fa.jpg");
        assert_eq!(r["next"][0]["url"], "https://store.epicgames.com/p/next");
        assert_eq!((r["now"].as_array().unwrap().len(), r["next"].as_array().unwrap().len()), (1, 1));
    }

    #[test]
    fn steam_answer_becomes_a_price() {
        let v = json!({ "570": { "success": true, "data": { "name": "Dota 2", "is_free": true, "header_image": "https://shared.akamai.steamstatic.com/h.jpg" } },
            "10": { "success": true, "data": { "name": "CS", "price_overview": { "final": 299, "initial": 999, "discount_percent": 70, "currency": "EUR" } } } });
        assert_eq!(parse_steam(&v, 570).unwrap()["free"], true);
        let cs = parse_steam(&v, 10).unwrap();
        assert_eq!((cs["final"].as_u64(), cs["discount"].as_u64()), (Some(299), Some(70)));
        assert!(parse_steam(&json!({ "11": { "success": false } }), 11).is_none());
    }

    #[test]
    fn failures_are_cached_and_retried_after_five_minutes() {
        let calls = std::cell::Cell::new(0);
        let fail = || { calls.set(calls.get() + 1); None };
        assert!(cached("test:never".into(), fail).is_none());
        assert!(cached("test:never".into(), fail).is_none());
        assert_eq!(calls.get(), 1);
        let age = |key: &str, ms: u64| CACHE.lock().unwrap().get_mut(key).unwrap().0 -= ms;
        age("test:never", RETRY_MS + 1);
        assert!(cached("test:never".into(), fail).is_none());
        assert_eq!(calls.get(), 2);
        // An old good value survives a failure, marked stale, and is retried after 5 minutes too.
        cached("test:good".into(), || Some(json!(1)));
        age("test:good", FRESH_MS + 1);
        assert_eq!(cached("test:good".into(), fail).map(|(_, v, stale)| (v, stale)), Some((json!(1), true)));
        assert_eq!(calls.get(), 3);
        age("test:good", RETRY_MS + 1);
        assert_eq!(cached("test:good".into(), || Some(json!(2))).map(|(_, v, stale)| (v, stale)), Some((json!(2), false)));
    }

    /// Calls the stores: `cargo test -- --ignored live_deals --nocapture`.
    #[test]
    #[ignore]
    fn live_deals() {
        let s = snapshot("FR", "1245620");
        eprintln!("{}", serde_json::to_string_pretty(&s).unwrap());
        assert!(s["epic"]["now"].is_array());
        assert_eq!(s["steam"][0]["name"], "ELDEN RING");
    }
}
