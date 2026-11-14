use std::{env, path::PathBuf, process::Command};
fn main() {
    println!("cargo:rerun-if-changed=native/preview.m");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let target = env::var("TARGET").unwrap();
    let arch = if target.starts_with("aarch64") {
        "arm64"
    } else {
        "x86_64"
    };
    assert!(
        Command::new("xcrun")
            .args([
                "clang",
                "-fobjc-arc",
                "-arch",
                arch,
                "-mmacosx-version-min=11.0",
                "-c",
                "native/preview.m",
                "-o"
            ])
            .arg(out.join("preview.o"))
            .status()
            .unwrap()
            .success()
    );
    assert!(
        Command::new("ar")
            .arg("crs")
            .arg(out.join("libopenrecord_preview.a"))
            .arg(out.join("preview.o"))
            .status()
            .unwrap()
            .success()
    );
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=openrecord_preview");
    println!("cargo:rustc-link-lib=framework=Cocoa");
    println!("cargo:rustc-link-lib=framework=WebKit");
    println!("cargo:rustc-link-lib=framework=QuartzCore");
    println!("cargo:rustc-link-lib=framework=AuthenticationServices");
}
