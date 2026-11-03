//! Application icons for the Screen Time page: the icon of an executable as a small PNG.
//! Only the image is kept (keyed by the application's display name), never the path it came from.

/// Encodes RGBA pixels as a PNG with uncompressed (stored) deflate blocks: no compression crate needed,
/// and a 32 x 32 icon stays about 4 KB.
pub fn png(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    let mut raw = Vec::with_capacity((w as usize * 4 + 1) * h as usize);
    for row in rgba.chunks(w as usize * 4).take(h as usize) {
        raw.push(0); // filter: none
        raw.extend_from_slice(row);
    }
    let mut z = vec![0x78, 0x01];
    let mut blocks = raw.chunks(65_535).peekable();
    while let Some(b) = blocks.next() {
        z.push(u8::from(blocks.peek().is_none()));
        let len = b.len() as u16;
        z.extend_from_slice(&len.to_le_bytes());
        z.extend_from_slice(&(!len).to_le_bytes());
        z.extend_from_slice(b);
    }
    z.extend_from_slice(&adler32(&raw).to_be_bytes());
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8 bits, RGBA
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    for (kind, data) in [(&b"IHDR"[..], &ihdr[..]), (b"IDAT", &z), (b"IEND", &[])] {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let start = out.len();
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        out.extend_from_slice(&crc32(&out[start..]).to_be_bytes());
    }
    out
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &x in data {
        a = (a + x as u32) % 65_521;
        b = (b + a) % 65_521;
    }
    (b << 16) | a
}

fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &x in data {
        c ^= x as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
    }
    !c
}

/// The large (32 x 32) icon of an executable, as PNG.
#[cfg(windows)]
pub fn png_for_exe(path: &str) -> Option<Vec<u8>> {
    use std::ffi::c_void;
    use std::mem::size_of;
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HGDIOBJ,
    };
    use windows::Win32::UI::Shell::ExtractIconExW;
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

    let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let mut icon = HICON::default();
    if unsafe { ExtractIconExW(PCWSTR(wide.as_ptr()), 0, Some(&mut icon), None, 1) } == 0 || icon.is_invalid() {
        return None;
    }
    let mut info = ICONINFO::default();
    let got = unsafe { GetIconInfo(icon, &mut info) }.is_ok();
    let result = (|| {
        if !got || info.hbmColor.is_invalid() {
            return None;
        }
        let mut bm = BITMAP::default();
        if unsafe { GetObjectW(HGDIOBJ(info.hbmColor.0), size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut c_void)) } == 0 {
            return None;
        }
        let (w, h) = (bm.bmWidth, bm.bmHeight);
        if !(1..=256).contains(&w) || !(1..=256).contains(&h) {
            return None;
        }
        let dc = unsafe { CreateCompatibleDC(None) };
        let read = |hbm: HBITMAP| -> Option<Vec<u8>> {
            let mut bi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER { biSize: size_of::<BITMAPINFOHEADER>() as u32, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default() },
                ..Default::default()
            };
            let mut buf = vec![0u8; (w * h * 4) as usize];
            let lines = unsafe { GetDIBits(dc, hbm, 0, h as u32, Some(buf.as_mut_ptr() as *mut c_void), &mut bi, DIB_RGB_COLORS) };
            (lines == h).then_some(buf)
        };
        let colour = read(info.hbmColor);
        // Old icons carry no alpha: the 1-bit mask (black = opaque) says which pixels are drawn.
        let mask = if colour.as_ref().is_some_and(|c| c.chunks(4).all(|p| p[3] == 0)) && !info.hbmMask.is_invalid() { read(info.hbmMask) } else { None };
        let _ = unsafe { DeleteDC(dc) };
        let mut px = colour?;
        for (i, p) in px.chunks_mut(4).enumerate() {
            p.swap(0, 2); // BGRA -> RGBA
            if let Some(m) = &mask {
                p[3] = if m[i * 4] == 0 { 255 } else { 0 };
            }
        }
        Some(png(w as u32, h as u32, &px))
    })();
    unsafe {
        if !info.hbmColor.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(info.hbmColor.0));
        }
        if !info.hbmMask.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(info.hbmMask.0));
        }
        let _ = DestroyIcon(icon);
    }
    result
}

#[cfg(not(windows))]
pub fn png_for_exe(_: &str) -> Option<Vec<u8>> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_is_well_formed() {
        let img = png(2, 2, &[255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0]);
        assert_eq!(&img[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(&img[12..16], b"IHDR");
        assert_eq!(u32::from_be_bytes(img[16..20].try_into().unwrap()), 2);
        assert_eq!(&img[img.len() - 8..img.len() - 4], b"IEND");
        // Known values: the CRC of "IEND" and the Adler-32 of "Wikipedia".
        assert_eq!(crc32(b"IEND"), 0xAE42_6082);
        assert_eq!(adler32(b"Wikipedia"), 0x11E6_0398);
    }

    #[cfg(windows)]
    #[test]
    fn reads_a_real_executable_icon() {
        let exe = std::path::Path::new(&std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".into())).join("explorer.exe");
        let img = png_for_exe(&exe.to_string_lossy()).expect("explorer.exe has an icon");
        let w = u32::from_be_bytes(img[16..20].try_into().unwrap());
        assert!((16..=256).contains(&w), "width {w}");
        // ICON_DUMP=<file> saves it, to look at the result.
        if let Ok(out) = std::env::var("ICON_DUMP") {
            std::fs::write(out, &img).unwrap();
        }
        assert!(png_for_exe(r"C:\definitely\not\here.exe").is_none());
    }
}
