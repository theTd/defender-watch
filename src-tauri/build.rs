#[path = "src/sha256.rs"]
mod sha256;

use std::fs;
use std::path::PathBuf;

fn main() {
    tauri_build::build();
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let collector = manifest.join("../collector/collector.ps1");
    println!("cargo:rerun-if-changed={}", collector.display());
    let source = fs::read(&collector).expect("read collector/collector.ps1 to embed it");
    let hash = sha256::sha256_hex(&source);
    println!("cargo:rustc-env=DEFENDER_WATCH_COLLECTOR_SHA256={hash}");
}
