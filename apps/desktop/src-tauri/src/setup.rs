// apps/desktop/src-tauri/src/setup.rs
//! Pre-daemon setup: what the first-launch screen needs before any project (and so
//! any dispatchd) exists — git itself, git's identity, and making a folder a repo.

use std::path::{Path, PathBuf};
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
    /// `/`, the home folder or one of its standard folders: too much to track.
    too_broad: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInstall {
    path: String,
    /// False when the linked folder isn't on this app's PATH (so likely not the shell's).
    on_path: bool,
}

/// Home's standard folders that are never a single project.
const BROAD_HOME_CHILDREN: &[&str] = &[
    "Desktop",
    "Documents",
    "Downloads",
    "Library",
    "Movies",
    "Music",
    "Pictures",
    "Public",
    "Applications",
];

/// True for a folder too broad to make a project of: `/`, home, or a standard child of home.
pub(crate) fn is_too_broad(path: &Path, home: Option<&Path>) -> bool {
    if path.parent().is_none() {
        return true;
    }
    let Some(home) = home else { return false };
    path == home
        || (path.parent() == Some(home)
            && path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| BROAD_HOME_CHILDREN.contains(&n)))
}

// Resolves symlinks (e.g. /tmp -> /private/tmp) so comparisons see one spelling.
fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// True only when `dir` is the top of its own repo, not a folder inside a parent repo.
fn is_own_repo(dir: &Path, extra_env: &[(&str, &str)]) -> bool {
    git(&["rev-parse", "--show-toplevel"], Some(dir), extra_env)
        .map(|top| canonical(Path::new(&top)) == canonical(dir))
        .unwrap_or(false)
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
    let bin = git_binary().ok_or_else(|| "git is not installed".to_string())?;
    let mut cmd = Command::new(bin);
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

// Picks the git to run. On macOS without the command line tools, /usr/bin/git is a stub
// that pops Apple's installer, so only a git found in another PATH dir is usable.
pub(crate) fn select_git(clt_present: bool, dirs: &[PathBuf]) -> Option<PathBuf> {
    if clt_present {
        return Some(PathBuf::from("git"));
    }
    dirs.iter()
        .filter(|d| d.as_path() != Path::new("/usr/bin"))
        .map(|d| d.join("git"))
        .find(|p| p.is_file())
}

// Resolves the git binary for this call (not cached, so installing the tools is noticed).
fn git_binary() -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return Some(PathBuf::from("git"));
    }
    let clt = Command::new("xcode-select")
        .arg("-p")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let dirs: Vec<PathBuf> = std::env::split_paths(&enriched_child_path()).collect();
    select_git(clt, &dirs)
}

fn git_installed() -> bool {
    git_binary().is_some() && git(&["--version"], None, &[]).is_ok()
}

#[tauri::command]
pub fn git_setup_status() -> GitSetupStatus {
    if !git_installed() {
        let install_hint = if cfg!(target_os = "linux") {
            Some(linux_install_hint(
                &std::fs::read_to_string("/etc/os-release").unwrap_or_default(),
            ))
        } else {
            None
        };
        return GitSetupStatus {
            installed: false,
            version: None,
            name: None,
            email: None,
            install_hint,
        };
    }
    let non_empty = |r: Result<String, String>| r.ok().filter(|s| !s.is_empty());
    GitSetupStatus {
        installed: true,
        version: non_empty(git(&["--version"], None, &[])),
        name: non_empty(git(
            &["config", "--global", "--get", "user.name"],
            None,
            &[],
        )),
        email: non_empty(git(
            &["config", "--global", "--get", "user.email"],
            None,
            &[],
        )),
        install_hint: None,
    }
}

#[tauri::command]
pub fn install_git() -> Result<(), String> {
    if cfg!(target_os = "macos") {
        Command::new("xcode-select")
            .arg("--install")
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    } else {
        Err(linux_install_hint(
            &std::fs::read_to_string("/etc/os-release").unwrap_or_default(),
        ))
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
pub async fn project_folder_state(path: String) -> Result<FolderState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        project_folder_state_with(Path::new(&path), home.as_deref(), &[])
    })
    .await
    .map_err(|e| e.to_string())
}

pub(crate) fn project_folder_state_with(
    dir: &Path,
    home: Option<&Path>,
    extra_env: &[(&str, &str)],
) -> FolderState {
    let is_dir = dir.is_dir();
    let is_git_repo = is_dir && is_own_repo(dir, extra_env);
    let has_commits =
        is_git_repo && git(&["rev-parse", "--verify", "HEAD"], Some(dir), extra_env).is_ok();
    FolderState {
        is_dir,
        is_git_repo,
        has_commits,
        has_gitignore: dir.join(".gitignore").is_file(),
        too_broad: is_too_broad(&canonical(dir), home.map(canonical).as_deref()),
    }
}

/// Makes `path` a repo with a first commit, writing a default .gitignore if none exists.
pub(crate) fn prepare_project_folder_with(
    path: &Path,
    extra_env: &[(&str, &str)],
) -> Result<(), String> {
    if !path.is_dir() {
        return Err(format!("not a folder: {}", path.display()));
    }
    // A folder inside a parent repo gets its own, so only its files are tracked.
    if !is_own_repo(path, extra_env) {
        git(&["init", "-b", "main"], Some(path), extra_env)?;
    }
    let gitignore = path.join(".gitignore");
    if !gitignore.exists() {
        std::fs::write(&gitignore, DEFAULT_GITIGNORE).map_err(|e| e.to_string())?;
    }
    if git(&["rev-parse", "--verify", "HEAD"], Some(path), extra_env).is_err() {
        git(&["add", "-A"], Some(path), extra_env)?;
        git(
            &[
                "commit",
                "--allow-empty",
                "-m",
                "Start tracking with Dispatch",
            ],
            Some(path),
            extra_env,
        )?;
    }
    Ok(())
}

#[tauri::command]
pub async fn prepare_project_folder(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || prepare_project_folder_with(Path::new(&path), &[]))
        .await
        .map_err(|e| e.to_string())?
}

/// Symlinks `bundled` as `dispatch` into the first candidate dir that exists (or,
/// for ~/.local/bin, can be created) and is writable. No sudo: /usr/local/bin is
/// tried first and skipped when not writable. Only an existing symlink is replaced;
/// a real `dispatch` file blocks that dir.
pub(crate) fn link_cli(bundled: &Path, candidates: &[PathBuf]) -> Result<PathBuf, String> {
    let mut blocked: Option<PathBuf> = None;
    for dir in candidates {
        let is_home_local = dir.ends_with(".local/bin");
        if !dir.is_dir() && is_home_local {
            let _ = std::fs::create_dir_all(dir);
        }
        if !dir.is_dir() {
            continue;
        }
        let target = dir.join("dispatch");
        match std::fs::symlink_metadata(&target) {
            Ok(meta) if meta.file_type().is_symlink() => {
                let _ = std::fs::remove_file(&target);
            }
            Ok(_) => {
                blocked.get_or_insert(target);
                continue;
            }
            Err(_) => {}
        }
        #[cfg(unix)]
        if std::os::unix::fs::symlink(bundled, &target).is_ok() {
            return Ok(target);
        }
    }
    match blocked {
        Some(path) => Err(format!(
            "Another `dispatch` command is already installed at {}.",
            path.display()
        )),
        None => {
            Err("No writable folder on your PATH. Add ~/.local/bin to PATH and try again.".into())
        }
    }
}

/// Whether `dir` is on `path_var` (this app's PATH) or is /usr/local/bin, which every
/// login shell has even when a GUI app's PATH doesn't.
pub(crate) fn dir_on_path(dir: &Path, path_var: &std::ffi::OsStr) -> bool {
    dir == Path::new("/usr/local/bin") || std::env::split_paths(path_var).any(|p| p == dir)
}

/// Links the bundled `dispatch` CLI onto the user's PATH and says where, and whether
/// that folder is on PATH.
#[tauri::command]
pub async fn install_cli_command(app: tauri::AppHandle) -> Result<CliInstall, String> {
    use tauri::Manager;
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("resources")
        .join("dispatch-cli");
    tauri::async_runtime::spawn_blocking(move || {
        if !bundled.is_file() {
            return Err(
                "This build doesn't include the dispatch command (dev builds don't).".to_string(),
            );
        }
        let home = std::env::var("HOME").map_err(|e| e.to_string())?;
        let linked = link_cli(
            &bundled,
            &["/usr/local/bin".into(), Path::new(&home).join(".local/bin")],
        )?;
        let path_var = std::env::var_os("PATH").unwrap_or_default();
        let on_path = linked
            .parent()
            .is_some_and(|dir| dir_on_path(dir, &path_var));
        Ok(CliInstall {
            path: linked.display().to_string(),
            on_path,
        })
    })
    .await
    .map_err(|e| e.to_string())?
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
    fn links_the_cli_into_the_first_writable_dir() {
        let base = temp_dir("cli-link");
        let bundled = base.join("dispatch-cli");
        std::fs::write(&bundled, "#!/bin/sh\n").unwrap();
        let unwritable = base.join("missing/bin");
        let writable = base.join("home/.local/bin");

        let linked = link_cli(&bundled, &[unwritable.clone(), writable.clone()]).unwrap();

        assert_eq!(linked, writable.join("dispatch"));
        assert_eq!(std::fs::read_link(&linked).unwrap(), bundled);
        // Idempotent: a second run replaces the link instead of failing.
        assert_eq!(
            link_cli(&bundled, &[unwritable, writable.clone()]).unwrap(),
            writable.join("dispatch")
        );
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn never_removes_a_real_dispatch_file() {
        let base = temp_dir("cli-blocked");
        let bundled = base.join("dispatch-cli");
        std::fs::write(&bundled, "#!/bin/sh\n").unwrap();
        let taken = base.join("taken/bin");
        std::fs::create_dir_all(&taken).unwrap();
        std::fs::write(taken.join("dispatch"), "mine").unwrap();
        let free = base.join("home/.local/bin");

        // Skips the blocked dir and links into the next one.
        let linked = link_cli(&bundled, &[taken.clone(), free.clone()]).unwrap();
        assert_eq!(linked, free.join("dispatch"));
        assert_eq!(
            std::fs::read_to_string(taken.join("dispatch")).unwrap(),
            "mine"
        );

        // With no other dir, it errors and still leaves the file alone.
        let err = link_cli(&bundled, std::slice::from_ref(&taken)).unwrap_err();
        assert!(err.contains("already installed at"), "{err}");
        assert!(err.contains(&taken.join("dispatch").display().to_string()));
        assert_eq!(
            std::fs::read_to_string(taken.join("dispatch")).unwrap(),
            "mine"
        );
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn dir_on_path_checks_path_and_usr_local_bin() {
        let path = std::ffi::OsString::from("/usr/bin:/home/a/.local/bin");
        assert!(dir_on_path(Path::new("/home/a/.local/bin"), &path));
        assert!(dir_on_path(Path::new("/usr/local/bin"), &path));
        assert!(!dir_on_path(
            Path::new("/home/a/.local/bin"),
            &std::ffi::OsString::from("/usr/bin:/bin")
        ));
    }

    #[test]
    fn too_broad_folders_are_refused() {
        let home = Path::new("/Users/ada");
        assert!(is_too_broad(Path::new("/"), Some(home)));
        assert!(is_too_broad(home, Some(home)));
        assert!(is_too_broad(Path::new("/Users/ada/Documents"), Some(home)));
        assert!(is_too_broad(Path::new("/Users/ada/Desktop/"), Some(home)));
        assert!(!is_too_broad(
            Path::new("/Users/ada/Documents/site"),
            Some(home)
        ));
        assert!(!is_too_broad(Path::new("/Users/ada/code"), Some(home)));
        assert!(!is_too_broad(Path::new("/Users/ada/code"), None));
    }

    #[test]
    fn folder_state_flags_home_as_too_broad() {
        let home = temp_dir("broad-home");
        std::fs::create_dir_all(home.join("Documents/site")).unwrap();
        assert!(project_folder_state_with(&home, Some(&home), ENV).too_broad);
        assert!(project_folder_state_with(&home.join("Documents"), Some(&home), ENV).too_broad);
        assert!(
            !project_folder_state_with(&home.join("Documents/site"), Some(&home), ENV).too_broad
        );
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn a_subfolder_of_a_parent_repo_is_not_its_own_repo() {
        for with_commits in [false, true] {
            let parent = temp_dir(&format!("parent-{with_commits}"));
            git(&["init", "-b", "main"], Some(&parent), ENV).unwrap();
            std::fs::write(parent.join("private.txt"), "parent file").unwrap();
            if with_commits {
                git(&["add", "-A"], Some(&parent), ENV).unwrap();
                git(&["commit", "-m", "parent"], Some(&parent), ENV).unwrap();
            }
            let sub = parent.join("site");
            std::fs::create_dir_all(&sub).unwrap();
            std::fs::write(sub.join("index.html"), "<h1>hi</h1>").unwrap();

            let state = project_folder_state_with(&sub, None, ENV);
            assert!(!state.is_git_repo, "with_commits={with_commits}");
            assert!(!state.has_commits);

            prepare_project_folder_with(&sub, ENV).unwrap();

            assert!(sub.join(".git").is_dir());
            let tracked = git(&["ls-files"], Some(&sub), ENV).unwrap();
            assert!(tracked.contains("index.html"));
            assert!(!tracked.contains("private.txt"));
            assert!(project_folder_state_with(&sub, None, ENV).has_commits);
            std::fs::remove_dir_all(&parent).unwrap();
        }
    }

    #[test]
    fn select_git_uses_plain_git_when_tools_present() {
        let dirs = vec![PathBuf::from("/usr/bin")];
        assert_eq!(select_git(true, &dirs), Some(PathBuf::from("git")));
    }

    #[test]
    fn select_git_skips_the_stub_dir_without_tools() {
        let dir = temp_dir("select-git");
        std::fs::write(dir.join("git"), "").unwrap();
        let dirs = vec![PathBuf::from("/usr/bin"), dir.clone()];
        assert_eq!(select_git(false, &dirs), Some(dir.join("git")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn select_git_is_none_with_only_the_stub() {
        let dirs = vec![PathBuf::from("/usr/bin")];
        assert_eq!(select_git(false, &dirs), None);
    }

    #[test]
    fn linux_hint_matches_distro() {
        assert_eq!(linux_install_hint("ID=fedora\n"), "sudo dnf install git");
        assert_eq!(linux_install_hint("ID=arch\n"), "sudo pacman -S git");
        assert_eq!(
            linux_install_hint("ID=ubuntu\nID_LIKE=debian\n"),
            "sudo apt install git"
        );
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

        assert_eq!(
            std::fs::read_to_string(dir.join(".gitignore")).unwrap(),
            "secret.txt\n"
        );
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
        assert_eq!(
            git(&["rev-parse", "HEAD"], Some(&dir), ENV).unwrap(),
            before
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
