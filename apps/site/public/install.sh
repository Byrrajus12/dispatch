#!/bin/sh
# Installs Dispatch on a Mac:
#
#   curl -fsSL https://dispatch.foo/install.sh | sh
#
# Downloads the newest Dispatch release (an `app-v*` tag on wsoule/dispatch),
# checks that Dispatch.app is signed by Dispatch's Developer ID, copies it
# into /Applications (or ~/Applications) and links `dispatch-core` and
# `dispatch-app` into ~/.local/bin. Never uses sudo.
#
# Environment, mostly for testing:
#   DISPATCH_INSTALL_DMG        a local DMG to install instead of downloading
#   DISPATCH_INSTALL_API        the releases list URL (file:// works)
#   DISPATCH_INSTALL_APPS       stands in for /Applications
#   DISPATCH_INSTALL_USER_APPS  stands in for ~/Applications
#   DISPATCH_INSTALL_BIN        stands in for ~/.local/bin
set -eu

bundle_id=foo.dispatch.Dispatch
team_id=6G9AQYBJ47
api=${DISPATCH_INSTALL_API:-https://api.github.com/repos/wsoule/dispatch/releases?per_page=100}
system_apps=${DISPATCH_INSTALL_APPS:-/Applications}
user_apps=${DISPATCH_INSTALL_USER_APPS:-$HOME/Applications}
bin=${DISPATCH_INSTALL_BIN:-$HOME/.local/bin}

say() { printf '%s\n' "$*"; }
die() { printf 'dispatch install: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "Dispatch installs on macOS only"

work=$(mktemp -d "${TMPDIR:-/tmp}/dispatch-install.XXXXXX")
mnt=$work/mnt
mounted=
cleanup() {
  if [ -n "$mounted" ]; then hdiutil detach -quiet "$mnt" || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Prints the download URL of the newest non-draft, non-prerelease `app-v*`
# release's universal DMG, from the GitHub releases list in $1.
pick_dmg_url() {
  osascript -l JavaScript - "$1" <<'EOF'
function run(argv) {
  const text = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null);
  const releases = JSON.parse(ObjC.unwrap(text));
  for (const r of releases) {
    if (r.draft || r.prerelease || !String(r.tag_name).startsWith("app-v")) continue;
    const a = (r.assets || []).find((x) => /^Dispatch_.*_universal\.dmg$/.test(x.name));
    if (a) return a.browser_download_url;
  }
  return "";
}
EOF
}

dmg=${DISPATCH_INSTALL_DMG:-}
if [ -z "$dmg" ]; then
  say "Looking for the newest Dispatch release"
  curl -fsSL -H "Accept: application/vnd.github+json" -o "$work/releases.json" "$api" ||
    die "could not list releases at $api"
  url=$(pick_dmg_url "$work/releases.json")
  [ -n "$url" ] || die "no app-v* release with a Dispatch_*_universal.dmg found"
  say "Downloading $url"
  dmg=$work/Dispatch.dmg
  curl -fL --progress-bar -o "$dmg" "$url" || die "download failed"
fi
[ -f "$dmg" ] || die "no DMG at $dmg"

mkdir "$mnt"
hdiutil attach -quiet -nobrowse -readonly -noautoopen -mountpoint "$mnt" "$dmg" ||
  die "could not open $dmg"
mounted=1
src=$mnt/Dispatch.app
[ -d "$src" ] || die "the DMG holds no Dispatch.app"

# Signed by Dispatch's Developer ID, sealed, and the app we expect.
requirement="identifier \"$bundle_id\" and anchor apple generic and certificate leaf[subject.OU] = \"$team_id\""
codesign --verify --deep --strict -R="$requirement" "$src" ||
  die "Dispatch.app in the DMG is not signed by team $team_id; not installing it"
say "Signature checked: $bundle_id, team $team_id"

# The bundle id of the app at $1, or nothing.
bundle_id_of() {
  /usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$1/Contents/Info.plist" 2>/dev/null || true
}

# /Applications/Dispatch.app may be the older Dispatch (dev.dispatch.app):
# never replace an app that is not this one.
dest=
existing=$system_apps/Dispatch.app
if [ -w "$system_apps" ]; then
  if [ ! -e "$existing" ] || [ "$(bundle_id_of "$existing")" = "$bundle_id" ]; then
    dest=$existing
  else
    say "$existing is another app ($(bundle_id_of "$existing")); leaving it alone."
  fi
else
  say "$system_apps is not writable without sudo."
fi
if [ -z "$dest" ]; then
  dest=$user_apps/Dispatch.app
  if [ -e "$dest" ] && [ "$(bundle_id_of "$dest")" != "$bundle_id" ]; then
    die "$dest is another app ($(bundle_id_of "$dest")); move it away and run this again"
  fi
  mkdir -p "$user_apps"
  say "Installing into $user_apps instead."
fi

say "Installing $dest"
staged=$(dirname "$dest")/.Dispatch.app.installing
rm -rf "$staged"
ditto "$src" "$staged"
rm -rf "$dest"
mv "$staged" "$dest"

# Links replace earlier links; a real file there is someone's own and stays.
mkdir -p "$bin"
for program in dispatch-core dispatch-app; do
  link=$bin/$program
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    say "Left $link alone: it is a file, not a link. Remove it to use $dest's $program."
  else
    ln -sfn "$dest/Contents/MacOS/$program" "$link"
    say "Linked $link"
  fi
done

case ":$PATH:" in
  *":$bin:"*) ;;
  *)
    say ""
    say "$bin is not on your PATH. Add it, e.g. for zsh:"
    say "  echo 'export PATH=\"$bin:\$PATH\"' >> ~/.zshrc"
    ;;
esac

say ""
say "Dispatch is installed. Open it from $(dirname "$dest") or run: open \"$dest\""
