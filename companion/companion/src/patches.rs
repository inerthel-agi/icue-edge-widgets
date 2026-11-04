//! Patch Radar widget: the official announcements (patch notes, updates, events) of the Steam games the user
//! lists, from Steam's public news endpoint (no key; it sends no CORS headers, hence this proxy). Only the app
//! ids are sent. Each game is fetched at most once an hour (cache shared with Free Games).
use crate::deals::{cached, get, parse_apps};
use serde_json::{json, Value};

/// Plain text from a news body: BBCode and HTML tags dropped, whitespace folded, 180 characters at most.
pub fn plain(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut depth_sq = 0;
    let mut depth_angle = 0;
    for c in raw.chars() {
        match c {
            '[' => depth_sq += 1,
            ']' if depth_sq > 0 => depth_sq -= 1,
            '<' => depth_angle += 1,
            '>' if depth_angle > 0 => depth_angle -= 1,
            _ if depth_sq == 0 && depth_angle == 0 => out.push(c),
            _ => {}
        }
    }
    let folded = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut s: String = folded.chars().take(180).collect();
    if folded.chars().count() > 180 {
        s.push('…');
    }
    s
}

/// Up to three announcements from a `GetNewsForApp` answer, newest first.
pub fn parse_news(v: &Value) -> Vec<Value> {
    v.pointer("/appnews/newsitems").and_then(Value::as_array).into_iter().flatten().take(3).filter_map(|n| {
        let url = n["url"].as_str().filter(|u| u.starts_with("https://"))?;
        Some(json!({
            "title": n["title"].as_str()?.chars().take(140).collect::<String>(),
            "at": n["date"].as_u64()? * 1000,
            "url": url,
            "text": plain(n["contents"].as_str().unwrap_or("")),
            "patch": n["tags"].as_array().is_some_and(|t| t.iter().any(|x| x == "patchnotes")) || n["title"].as_str().is_some_and(|t| { let l = t.to_lowercase(); l.contains("patch") || l.contains("update") || l.contains("hotfix") }),
        }))
    }).collect()
}

/// The `patches/1` snapshot for the listed app ids.
pub fn snapshot(apps: &str) -> Value {
    let games: Vec<Value> = parse_apps(apps).into_iter().map(|id| {
        let news = cached(format!("news:{id}"), || {
            get(&format!("https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid={id}&count=3&maxlength=600&feeds=steam_community_announcements")).map(|v| json!(parse_news(&v)))
        });
        let name = cached(format!("name:{id}"), || {
            get(&format!("https://store.steampowered.com/api/appdetails?appids={id}&filters=basic&l=en")).and_then(|v| v.pointer(&format!("/{id}/data/name")).cloned())
        });
        json!({
            "id": id,
            "name": name.map(|(_, n, _)| n).unwrap_or(json!(format!("App {id}"))),
            "items": news.as_ref().map(|(_, v, _)| v.clone()).unwrap_or(json!([])),
            "stale": news.as_ref().is_none_or(|n| n.2),
        })
    }).collect();
    json!({ "schema": "patches/1", "games": games })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn news_body_becomes_plain_text() {
        assert_eq!(plain("[b]Hotfix[/b] <br>fixes   the [url=x]crash[/url]."), "Hotfix fixes the crash.");
        assert!(plain(&"a ".repeat(200)).ends_with('…'));
    }

    #[test]
    fn news_answer_keeps_https_items_and_flags_patches() {
        let v = json!({ "appnews": { "newsitems": [
            { "title": "Title Update 1.72", "date": 1_700_000_000u64, "url": "https://steam/news/1", "contents": "[h1]Fixes[/h1]", "tags": ["patchnotes"] },
            { "title": "Halloween event", "date": 1_699_000_000u64, "url": "https://steam/news/2", "contents": "Spooky" },
            { "title": "Bad link", "date": 1u64, "url": "http://x", "contents": "" },
        ] } });
        let items = parse_news(&v);
        assert_eq!(items.len(), 2);
        assert_eq!((items[0]["patch"].as_bool(), items[1]["patch"].as_bool()), (Some(true), Some(false)));
        assert_eq!(items[0]["at"], 1_700_000_000_000u64);
    }

    /// Calls Steam: `cargo test -- --ignored live_patches --nocapture`.
    #[test]
    #[ignore]
    fn live_patches() {
        let s = snapshot("271590,1245620");
        eprintln!("{}", serde_json::to_string_pretty(&s).unwrap());
        assert_eq!(s["games"][0]["name"], "Grand Theft Auto V Legacy");
    }
}
