// apps/desktop/src-tauri/src/setup.rs
//! Pre-daemon setup: what the first-launch screen needs before any project (and so
//! any dispatchd) exists — git itself, git's identity, and making a folder a repo.

use std::path::Path;
use std::process::Command;

use serde::Serialize;

use crate::sidecar::enriched_child_path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSetupStatus {
    installed: bool,
    version: Option<String>,
    name: Option<String>,
    email: Option<String>,
    install_hint: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderState {
    is_dir: bool,
    is_git_repo: bool,
    has_commits: bool,
    has_gitignore: bool,
}

/// Written only when a folder has no .gitignore, so secrets and dependencies stay out
/// of the first snapshot a non-developer takes.
pub(crate) const DEFAULT_GITIGNORE: &str = "\
# Added by Dispatch. Edit freely.
.env
.env.*
!.env.example
node_modules/
.venv/
venv/
__pycache__/
dist/
build/
.next/
.DS_Store
*.log
";

fn git(args: &[&str], cwd: Option<&Path>, extra_env: &[(&str, &str)]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(args).env("PATH", enriched_child_path());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Linux install command for the distro named in /etc/os-release.
pub(crate) fn linux_install_hint(os_release: &str) -> String {
    let ids = os_release.to_lowercase();
    if ids.contains("fedora") || ids.contains("rhel") {
        "sudo dnf install git".into()
    } else if ids.contains("arch") {
        "sudo pacman -S git".into()
    } else {
        "sudo apt install git".into()
    }
}

// On macOS /usr/bin/git is a stub that pops Apple's installer when run without the
// command line tools, so check for the tools instead of running it.
fn git_installed() -> bool {
    if cfg!(target_os = "macos") {
        let real_git_elsewhere = std::env::split_paths(&enriched_child_path())
            .filter(|d| d != Path::new("/usr/bin"))
            .any(|d| d.join("git").is_file());
        let clt = Command::new("xcode-select").arg("-p").output().map(|o| o.status.success()).unwrap_or(false);
        real_git_elsewhere || clt
    } else {
        git(&["--version"], None, &[]).is_ok()
    }
}

#[tauri::command]
pub fn git_setup_status() -> GitSetupStatus {
    if !git_installed() {
        let install_hint = if cfg!(target_os = "linux") {
            Some(linux_install_hint(&std::fs::read_to_string("/etc/os-release").unwrap_or_default()))
        } else {
            None
        };
        return GitSetupStatus { installed: false, version: None, name: None, email: None, install_hint };
    }
    let non_empty = |r: Result<String, String>| r.ok().filter(|s| !s.is_empty());
    GitSetupStatus {
        installed: true,
        version: non_empty(git(&["--version"], None, &[])),
        name: non_empty(git(&["config", "--global", "--get", "user.name"], None, &[])),
        email: non_empty(git(&["config", "--global", "--get", "user.email"], None, &[])),
        install_hint: None,
    }
}

#[tauri::command]
pub fn install_git() -> Result<(), String> {
    if cfg!(target_os = "macos") {
        Command::new("xcode-select").arg("--install").spawn().map(|_| ()).map_err(|e| e.to_string())
    } else {
        Err(linux_install_hint(&std::fs::read_to_string("/etc/os-release").unwrap_or_default()))
    }
}

#[tauri::command]
pub fn set_git_identity(name: String, email: String) -> Result<(), String> {
    let (name, email) = (name.trim(), email.trim());
    if name.is_empty() || !email.contains('@') {
        return Err("Enter your name and a valid email.".into());
    }
    git(&["config", "--global", "user.name", name], None, &[])?;
    git(&["config", "--global", "user.email", email], None, &[])?;
    Ok(())
}

#[tauri::command]
pub fn project_folder_state(path: String) -> FolderState {
    let dir = Path::new(&path);
    let is_dir = dir.is_dir();
    let is_git_repo = is_dir && git(&["rev-parse", "--is-inside-work-tree"], Some(dir), &[]).map(|s| s == "true").unwrap_or(false);
    let has_commits = is_git_repo && git(&["rev-parse", "--verify", "HEAD"], Some(dir), &[]).is_ok();
    FolderState { is_dir, is_git_repo, has_commits, has_gitignore: dir.join(".gitignore").is_file() }
}

/// Makes `path` a repo with a first commit, writing a default .gitignore if none exists.
pub(crate) fn prepare_project_folder_with(path: &Path, extra_env: &[(&str, &str)]) -> Result<(), String> {
    if !path.is_dir() {
        return Err(format!("not a folder: {}", path.display()));
    }
    let is_repo = git(&["rev-parse", "--is-inside-work-tree"], Some(path), extra_env).map(|s| s == "true").unwrap_or(false);
    if !is_repo {
        git(&["init", "-b", "main"], Some(path), extra_env)?;
    }
    let gitignore = path.join(".gitignore");
    if !gitignore.exists() {
        std::fs::write(&gitignore, DEFAULT_GITIGNORE).map_err(|e| e.to_string())?;
    }
    if git(&["rev-parse", "--verify", "HEAD"], Some(path), extra_env).is_err() {
        git(&["add", "-A"], Some(path), extra_env)?;
        git(&["commit", "--allow-empty", "-m", "Start tracking with Dispatch"], Some(path), extra_env)?;
    }
    Ok(())
}

#[tauri::command]
pub fn prepare_project_folder(path: String) -> Result<(), String> {
    prepare_project_folder_with(Path::new(&path), &[])
}

#[cfg(test)]
mod tests {
    use super::*;

    // Hermetic git: no global config (avoids a developer's init.defaultBranch etc.).
    const ENV: &[(&str, &str)] = &[
        ("GIT_CONFIG_GLOBAL", "/dev/null"),
        ("GIT_CONFIG_NOSYSTEM", "1"),
        ("GIT_AUTHOR_NAME", "Test"),
        ("GIT_AUTHOR_EMAIL", "t@example.com"),
        ("GIT_COMMITTER_NAME", "Test"),
        ("GIT_COMMITTER_EMAIL", "t@example.com"),
    ];

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("dispatch-setup-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn linux_hint_matches_distro() {
        assert_eq!(linux_install_hint("ID=fedora\n"), "sudo dnf install git");
        assert_eq!(linux_install_hint("ID=arch\n"), "sudo pacman -S git");
        assert_eq!(linux_install_hint("ID=ubuntu\nID_LIKE=debian\n"), "sudo apt install git");
    }

    #[test]
    fn prepares_a_plain_folder_without_committing_secrets() {
        let dir = temp_dir("plain");
        std::fs::write(dir.join("index.html"), "<h1>hi</h1>").unwrap();
        std::fs::write(dir.join(".env"), "SECRET=1").unwrap();
        std::fs::create_dir_all(dir.join("node_modules/x")).unwrap();
        std::fs::write(dir.join("node_modules/x/i.js"), "").unwrap();

        prepare_project_folder_with(&dir, ENV).unwrap();

        let tracked = git(&["ls-files"], Some(&dir), ENV).unwrap();
        assert!(tracked.contains("index.html"));
        assert!(tracked.contains(".gitignore"));
        assert!(!tracked.contains(".env"));
        assert!(!tracked.contains("node_modules"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn respects_an_existing_gitignore() {
        let dir = temp_dir("own-ignore");
        std::fs::write(dir.join(".gitignore"), "secret.txt\n").unwrap();
        std::fs::write(dir.join("secret.txt"), "x").unwrap();
        std::fs::write(dir.join(".env"), "y").unwrap();

        prepare_project_folder_with(&dir, ENV).unwrap();

        assert_eq!(std::fs::read_to_string(dir.join(".gitignore")).unwrap(), "secret.txt\n");
        let tracked = git(&["ls-files"], Some(&dir), ENV).unwrap();
        assert!(!tracked.contains("secret.txt"));
        assert!(tracked.contains(".env")); // the user's own ignore rules are theirs
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn gives_an_empty_repo_its_first_commit() {
        let dir = temp_dir("empty-repo");
        git(&["init", "-b", "main"], Some(&dir), ENV).unwrap();
        prepare_project_folder_with(&dir, ENV).unwrap();
        assert!(git(&["rev-parse", "--verify", "HEAD"], Some(&dir), ENV).is_ok());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn leaves_a_repo_with_history_alone() {
        let dir = temp_dir("history");
        git(&["init", "-b", "main"], Some(&dir), ENV).unwrap();
        git(&["commit", "--allow-empty", "-m", "first"], Some(&dir), ENV).unwrap();
        let before = git(&["rev-parse", "HEAD"], Some(&dir), ENV).unwrap();
        prepare_project_folder_with(&dir, ENV).unwrap();
        assert_eq!(git(&["rev-parse", "HEAD"], Some(&dir), ENV).unwrap(), before);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
