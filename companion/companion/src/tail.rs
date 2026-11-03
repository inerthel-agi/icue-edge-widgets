//! Incremental JSONL reader: resumes from a saved offset, never re-reads
//! consumed bytes, waits for incomplete last lines, and restarts on truncation.
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

/// Bounded chunk: large backlogs are read in several calls so memory stays flat.
pub const MAX_READ: usize = 1024 * 1024;
const MAX_LINE: usize = 4 * 1024 * 1024;

pub struct Tail {
    pub path: PathBuf,
    /// Offset of the first byte not yet returned as a complete line.
    pub offset: u64,
    pending: Vec<u8>,
    last_change: u64,
    next_check: u64,
}

impl Tail {
    pub fn new(path: PathBuf, offset: u64) -> Self {
        // Start "active" if the file changed recently, so its next write is picked up within a second.
        let last_change = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Tail { path, offset, pending: Vec::new(), last_change, next_check: 0 }
    }

    /// Active files (changed in the last 10 min) are checked every second, quiet ones every 30 s.
    pub fn due(&self, now: u64) -> bool {
        now >= self.next_check
    }

    pub fn schedule(&mut self, now: u64, changed: bool) {
        if changed {
            self.last_change = now;
        }
        let quiet = now.saturating_sub(self.last_change) > 10 * 60 * 1000;
        self.next_check = now + if quiet { 30_000 } else { 1_000 };
    }

    /// Returns complete new lines. A partial last line stays pending until its newline arrives.
    pub fn read_lines(&mut self) -> std::io::Result<Vec<String>> {
        let len = std::fs::metadata(&self.path)?.len();
        let read_from = self.offset + self.pending.len() as u64;
        if len < read_from {
            // Truncated or replaced: start over, the caller's dedup protects against recounting.
            self.offset = 0;
            self.pending.clear();
        }
        let read_from = self.offset + self.pending.len() as u64;
        if len == read_from {
            return Ok(Vec::new());
        }
        let mut file = File::open(&self.path)?;
        file.seek(SeekFrom::Start(read_from))?;
        let want = ((len - read_from) as usize).min(MAX_READ);
        let mut buf = vec![0u8; want];
        let n = file.read(&mut buf)?;
        buf.truncate(n);
        self.pending.extend_from_slice(&buf);

        let mut lines = Vec::new();
        let mut start = 0;
        for (i, byte) in self.pending.iter().enumerate() {
            if *byte == b'\n' {
                let line = &self.pending[start..i];
                if !line.is_empty() {
                    lines.push(String::from_utf8_lossy(line).trim_end_matches('\r').to_string());
                }
                start = i + 1;
            }
        }
        self.offset += start as u64;
        self.pending.drain(..start);
        if self.pending.len() > MAX_LINE {
            // A single line this large is not a usage record; skip it instead of buffering forever.
            self.offset += self.pending.len() as u64;
            self.pending.clear();
        }
        Ok(lines)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("aum-tail-{}-{name}", std::process::id()));
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn partial_lines_wait_and_offsets_resume() {
        let p = tmp("partial");
        let mut f = File::create(&p).unwrap();
        f.write_all(b"{\"a\":1}\n{\"b\":").unwrap();
        f.flush().unwrap();
        let mut t = Tail::new(p.clone(), 0);
        assert_eq!(t.read_lines().unwrap(), vec!["{\"a\":1}"]);
        assert_eq!(t.offset, 8);
        f.write_all(b"2}\r\n").unwrap();
        f.flush().unwrap();
        assert_eq!(t.read_lines().unwrap(), vec!["{\"b\":2}"]);
        // A restarted reader resumes from the saved offset and sees nothing new.
        let mut again = Tail::new(p.clone(), t.offset);
        assert!(again.read_lines().unwrap().is_empty());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn truncation_restarts_from_zero() {
        let p = tmp("trunc");
        std::fs::write(&p, b"one\ntwo\n").unwrap();
        let mut t = Tail::new(p.clone(), 0);
        assert_eq!(t.read_lines().unwrap().len(), 2);
        std::fs::write(&p, b"x\n").unwrap();
        assert_eq!(t.read_lines().unwrap(), vec!["x"]);
        let _ = std::fs::remove_file(&p);
    }
}
