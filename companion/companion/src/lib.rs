//! iCUE Edge Companion core. Each feature lives in its own module; `usage` is the first.
//! No Tauri here: the tray and windows live in main.rs, which keeps this crate testable
//! on Windows (Tauri test binaries need an application manifest).
pub mod appicon;
pub mod community;
pub mod deals;
pub mod deck;
pub mod game;
pub mod http;
pub mod media;
pub mod mixer;
pub mod net;
pub mod patches;
pub mod screentime;
pub mod spotify;
pub mod stocks;
pub mod tail;
pub mod usage;
pub mod util;
pub mod widgets;
