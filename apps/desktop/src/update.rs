//! Updating the app in place from GitHub Releases.
//!
//! The Desktop workflow attaches `OpenRecord-<version>.dmg` to a release tagged
//! `desktop-v<version>`. `check` finds the newest such release; `install`
//! downloads its disk image, copies the app out of it next to the running
//! bundle, checks it, swaps the two, and relaunches. The work shells out to
//! the tools macOS ships (`curl`, `hdiutil`, `ditto`, `codesign`, `open`).
//!
//! What is checked before anything is replaced: the download comes from this
//! repository's releases over HTTPS and nowhere else; the copied bundle's
//! signature is intact (`codesign --verify --deep --strict`); and when the
//! running app is signed by a team, the new one is signed by the same team.
//! A build signed ad hoc (made on this Mac) has no team to compare, so only
//! the first two hold for it.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Where the releases are published.
pub const RELEASES: &str = "https://api.github.com/repos/commonfields/openrecord/releases?per_page=30";
const TAG_PREFIX: &str = "desktop-v";
/// The only place an update is downloaded from.
const DOWNLOADS: &str = "https://github.com/commonfields/openrecord/releases/download/";

/// Whether `url` is one of this repository's release assets, with nothing that could lead elsewhere.
fn trusted_download(url: &str) -> bool {
    url.strip_prefix(DOWNLOADS).is_some_and(|rest| !rest.is_empty() && !rest.contains("..") && !rest.contains(['?', '#', '@', '\\', ' ']))
}

/// The team that signed the bundle at `app` (`TeamIdentifier` in `codesign -dv`); `None` when unsigned or signed ad hoc.
fn team_of(app: &Path) -> Option<String> {
    let out = Command::new("codesign").args(["-dv", "--verbose=2"]).arg(app).output().ok()?;
    // codesign prints the details on stderr.
    team_in(&String::from_utf8_lossy(&out.stderr))
}

fn team_in(details: &str) -> Option<String> {
    let team = details.lines().find_map(|l| l.strip_prefix("TeamIdentifier="))?.trim();
    (!team.is_empty() && team != "not set").then(|| team.to_string())
}

/// Refuses a bundle whose signature is broken, or that another team signed.
fn verify(staged: &Path, running: &Path) -> Result<(), String> {
    run(Command::new("codesign").args(["--verify", "--deep", "--strict"]).arg(staged), "verify the downloaded app's signature")
        .map_err(|_| "The downloaded app's signature is not valid, so it was not installed.".to_string())?;
    match (team_of(running), team_of(staged)) {
        (Some(ours), Some(theirs)) if ours == theirs => Ok(()),
        (Some(_), _) => Err("The downloaded app is not signed by OpenRecord's developer, so it was not installed.".into()),
        (None, _) => Ok(()),
    }
}

/// This build's version, from Cargo.toml (the bundle's `CFBundleShortVersionString`).
pub fn current() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// A newer release than this build.
#[derive(Clone, Debug, PartialEq)]
pub struct Release {
    pub version: String,
    pub dmg_url: String,
    pub page_url: String,
}

/// Where updating stands, for the account menu.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Update {
    #[default]
    Unknown,
    Checking,
    UpToDate,
    Available(Release),
    /// Downloading and installing this version.
    Installing(String),
    Failed(String),
}

/// `"0.2.10"` as `[0, 2, 10]`; anything after a `-` or `+` is ignored.
fn parse(v: &str) -> Option<Vec<u64>> {
    let core = v.trim().trim_start_matches('v').split(['-', '+']).next()?;
    core.split('.').map(|p| p.parse().ok()).collect()
}

fn newer(candidate: &str, than: &str) -> bool {
    match (parse(candidate), parse(than)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

/// The newest published desktop release, when it is newer than `than`.
pub fn pick(releases: &serde_json::Value, than: &str) -> Option<Release> {
    let mut best: Option<Release> = None;
    for r in releases.as_array()? {
        if r["draft"].as_bool() == Some(true) || r["prerelease"].as_bool() == Some(true) {
            continue;
        }
        let Some(version) = r["tag_name"].as_str().and_then(|t| t.strip_prefix(TAG_PREFIX)) else { continue };
        let Some(dmg) = r["assets"].as_array().and_then(|a| a.iter().find(|x| x["name"].as_str().is_some_and(|n| n.ends_with(".dmg")))) else { continue };
        let Some(dmg_url) = dmg["browser_download_url"].as_str() else { continue };
        if !newer(version, than) || best.as_ref().is_some_and(|b| !newer(version, &b.version)) {
            continue;
        }
        best = Some(Release { version: version.to_string(), dmg_url: dmg_url.to_string(), page_url: r["html_url"].as_str().unwrap_or_default().to_string() });
    }
    best
}

fn run(cmd: &mut Command, what: &str) -> Result<String, String> {
    let out = cmd.output().map_err(|e| format!("Could not {what}: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let err = err.trim();
        Err(if err.is_empty() { format!("Could not {what}.") } else { format!("Could not {what}: {err}") })
    }
}

/// Asks GitHub for the releases and returns the newest one past this build.
pub fn check() -> Result<Option<Release>, String> {
    let body = run(
        Command::new("curl").args(["-fsSL", "--max-time", "20", "-H", "Accept: application/vnd.github+json", "-A", "OpenRecord-desktop", RELEASES]),
        "reach GitHub to check for updates",
    )?;
    let json: serde_json::Value = serde_json::from_str(&body).map_err(|_| "GitHub sent a release list this version can't read.".to_string())?;
    Ok(pick(&json, current()))
}

/// The `.app` bundle this process runs from, when it runs from one.
pub fn bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    // …/OpenRecord.app/Contents/MacOS/openrecord-desktop
    let app = exe.parent()?.parent()?.parent()?;
    (app.extension().is_some_and(|e| e == "app")).then(|| app.to_path_buf())
}

/// Downloads `r`, replaces the running bundle with it, and relaunches the new
/// app once this process has exited. The caller exits right after `Ok`.
pub fn install(r: &Release) -> Result<(), String> {
    let app = bundle().ok_or("Updates install into OpenRecord.app. This copy runs from a build folder, so rebuild it instead.")?;
    let parent = app.parent().ok_or("Could not find the folder the app is in.")?.to_path_buf();
    let work = std::env::temp_dir().join(format!("openrecord-update-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|e| format!("Could not make a folder for the download: {e}"))?;
    let result = install_from(r, &app, &parent, &work);
    let _ = std::fs::remove_dir_all(&work);
    result?;
    relaunch(&app)
}

fn install_from(r: &Release, app: &Path, parent: &Path, work: &Path) -> Result<(), String> {
    if !cfg!(test) && !trusted_download(&r.dmg_url) {
        return Err("The update does not come from OpenRecord's releases, so it was not downloaded.".into());
    }
    let dmg = work.join("OpenRecord.dmg");
    // HTTPS only, through every redirect GitHub makes to its download host.
    let mut curl = Command::new("curl");
    curl.args(["-fsSL", "--max-time", "600", "-A", "OpenRecord-desktop"]);
    if !cfg!(test) {
        curl.args(["--proto", "=https", "--proto-redir", "=https"]);
    }
    run(curl.arg("-o").arg(&dmg).arg(&r.dmg_url), "download the update")?;
    let mount = work.join("mount");
    run(Command::new("hdiutil").args(["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint"]).arg(&mount).arg(&dmg), "open the downloaded disk image")?;
    let staged = parent.join(".OpenRecord.app.update");
    let copied = (|| {
        let found = std::fs::read_dir(&mount)
            .map_err(|e| format!("Could not read the disk image: {e}"))?
            .filter_map(Result::ok)
            .map(|e| e.path())
            .find(|p| p.extension().is_some_and(|e| e == "app"))
            .ok_or("The disk image has no app in it.")?;
        let _ = std::fs::remove_dir_all(&staged);
        run(Command::new("ditto").arg(&found).arg(&staged), "copy the new version next to this one")
    })();
    let _ = Command::new("hdiutil").args(["detach", "-quiet", "-force"]).arg(&mount).output();
    copied?;
    if let Err(e) = verify(&staged, app) {
        let _ = std::fs::remove_dir_all(&staged);
        return Err(e);
    }
    // Swap: the old bundle steps aside, the new one takes its name, the old one goes.
    let old = parent.join(".OpenRecord.app.old");
    let _ = std::fs::remove_dir_all(&old);
    std::fs::rename(app, &old).map_err(|e| {
        let _ = std::fs::remove_dir_all(&staged);
        format!("Could not replace the app in {}: {e}. Move OpenRecord to a folder you can write to, such as Applications.", parent.display())
    })?;
    if let Err(e) = std::fs::rename(&staged, app) {
        let _ = std::fs::rename(&old, app);
        return Err(format!("Could not put the new version in place: {e}"));
    }
    let _ = std::fs::remove_dir_all(&old);
    Ok(())
}

/// Opens `app` again once this process has gone.
fn relaunch(app: &Path) -> Result<(), String> {
    let script = format!("while kill -0 {} 2>/dev/null; do sleep 0.2; done; open -n \"$0\"", std::process::id());
    Command::new("/bin/sh").arg("-c").arg(script).arg(app).spawn().map_err(|e| format!("The update is installed, but the app could not restart: {e}. Open it again."))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_by_number() {
        assert!(newer("0.10.0", "0.9.9"));
        assert!(newer("v1.0.0", "0.9.0"));
        assert!(!newer("0.1.0", "0.1.0"));
        assert!(!newer("0.1.0-beta", "0.1.0"));
        assert!(!newer("garbage", "0.1.0"));
    }

    #[test]
    fn picks_the_newest_desktop_release_with_a_disk_image() {
        let json = serde_json::json!([
            { "tag_name": "v9.0.0", "draft": false, "prerelease": false, "assets": [{ "name": "cli.tar.gz", "browser_download_url": "x" }] },
            { "tag_name": "desktop-v0.3.0", "draft": false, "prerelease": true, "assets": [{ "name": "OpenRecord-0.3.0.dmg", "browser_download_url": "pre" }] },
            { "tag_name": "desktop-v0.2.0", "draft": false, "prerelease": false, "html_url": "page", "assets": [{ "name": "OpenRecord-0.2.0.dmg", "browser_download_url": "dmg2" }] },
            { "tag_name": "desktop-v0.2.5", "draft": false, "prerelease": false, "assets": [] },
            { "tag_name": "desktop-v0.1.5", "draft": false, "prerelease": false, "assets": [{ "name": "OpenRecord-0.1.5.dmg", "browser_download_url": "dmg15" }] },
        ]);
        assert_eq!(pick(&json, "0.1.0"), Some(Release { version: "0.2.0".into(), dmg_url: "dmg2".into(), page_url: "page".into() }));
        assert_eq!(pick(&json, "0.2.0"), None);
    }

    #[test]
    fn downloads_only_from_this_repositorys_releases() {
        assert!(trusted_download("https://github.com/commonfields/openrecord/releases/download/desktop-v0.2.0/OpenRecord-0.2.0.dmg"));
        assert!(!trusted_download("http://github.com/commonfields/openrecord/releases/download/desktop-v0.2.0/OpenRecord-0.2.0.dmg"));
        assert!(!trusted_download("https://github.com/someone-else/openrecord/releases/download/desktop-v0.2.0/OpenRecord-0.2.0.dmg"));
        assert!(!trusted_download("https://github.com/commonfields/openrecord/releases/download/../../../evil/x.dmg"));
        assert!(!trusted_download("https://github.com/commonfields/openrecord/releases/download/x.dmg?redirect=https://evil.example"));
        assert!(!trusted_download("https://github.com/commonfields/openrecord/releases/download/"));
    }

    #[test]
    fn reads_the_signing_team_and_treats_ad_hoc_as_none() {
        assert_eq!(team_in("Identifier=io.openrecord.desktop\nTeamIdentifier=AB12CD34EF\nSealed Resources version=2"), Some("AB12CD34EF".into()));
        assert_eq!(team_in("Signature=adhoc\nTeamIdentifier=not set"), None);
        assert_eq!(team_in("code object is not signed at all"), None);
    }

    /// Installs a real disk image over a stand-in bundle:
    /// `OPENRECORD_TEST_DMG=dist/OpenRecord-0.1.0.dmg cargo test -- --ignored installs_from_a_disk_image`
    #[test]
    #[ignore]
    fn installs_from_a_disk_image() {
        let dmg = std::fs::canonicalize(std::env::var("OPENRECORD_TEST_DMG").expect("OPENRECORD_TEST_DMG")).unwrap();
        let root = std::env::temp_dir().join(format!("openrecord-update-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let app = root.join("Applications/OpenRecord.app");
        std::fs::create_dir_all(app.join("Contents")).unwrap();
        std::fs::write(app.join("Contents/old"), "old").unwrap();
        let work = root.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let r = Release { version: "9.9.9".into(), dmg_url: format!("file://{}", dmg.display()), page_url: String::new() };
        install_from(&r, &app, app.parent().unwrap(), &work).unwrap();
        assert!(app.join("Contents/MacOS/openrecord-desktop").exists());
        assert!(!app.join("Contents/old").exists());
        assert!(!root.join("Applications/.OpenRecord.app.old").exists());
        assert!(!root.join("Applications/.OpenRecord.app.update").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
