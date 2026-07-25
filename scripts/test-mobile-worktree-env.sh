#!/usr/bin/env bash
# Regression tests for the mobile worktree identity contract:
#   - scripts/mobile-worktree-env.sh writes debug-only override files in a
#     worktree and removes them in the main checkout.
#   - the tracked iOS/Android build files keep production identity and only
#     consume the overrides in debug configurations.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$repo_root/scripts/mobile-worktree-env.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

failures=0
fail() {
  printf 'FAIL: %s\n' "$1" >&2
  failures=$((failures + 1))
}
pass() {
  printf 'ok: %s\n' "$1"
}

make_repo() {
  # $1: repo dir, $2: initial branch name
  local repo="$1" branch="$2"
  mkdir -p "$repo/scripts" "$repo/mobile/ios/Flutter" "$repo/mobile/android"
  cp "$script" "$repo/scripts/mobile-worktree-env.sh"
  git -C "$repo" init -q -b "$branch"
  git -C "$repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
}

# ── Main checkout: no overrides, stale files removed ─────────────────────────
repo="$tmp/main-checkout"
make_repo "$repo" main
echo stale > "$repo/mobile/ios/Flutter/WorktreeOverrides.xcconfig"
echo stale > "$repo/mobile/android/worktree.properties"
"$repo/scripts/mobile-worktree-env.sh" > /dev/null
if [[ -e "$repo/mobile/ios/Flutter/WorktreeOverrides.xcconfig" || -e "$repo/mobile/android/worktree.properties" ]]; then
  fail "main checkout must remove stale worktree override files"
else
  pass "main checkout removes stale worktree override files"
fi

# ── Worktree: overrides written with sanitized identity ──────────────────────
wt="$tmp/wt-feature"
git -C "$repo" worktree add -q -b "tho/Fix_Thing-2" "$wt"
mkdir -p "$wt/scripts" "$wt/mobile/ios/Flutter" "$wt/mobile/android"
cp "$script" "$wt/scripts/mobile-worktree-env.sh"
out="$("$wt/scripts/mobile-worktree-env.sh")"
ios="$wt/mobile/ios/Flutter/WorktreeOverrides.xcconfig"
android="$wt/mobile/android/worktree.properties"
[[ -f "$ios" && -f "$android" ]] || fail "worktree must write both override files"
grep -q '^BUNDLE_IDENTIFIER = com\.buzz\.buzzMobile\.tho-fix-thing-2$' "$ios" \
  && pass "iOS bundle identifier gets sanitized per-worktree suffix" \
  || fail "iOS bundle identifier suffix wrong: $(cat "$ios")"
grep -q '^APP_DISPLAY_NAME = Buzz (Fix_Thing-2)$' "$ios" \
  && pass "iOS display name carries the branch label" \
  || fail "iOS display name wrong: $(cat "$ios")"
grep -q '^label=Fix_Thing-2$' "$android" \
  && pass "Android label carries the branch label" \
  || fail "Android label wrong: $(cat "$android")"
grep -q '^applicationIdSuffix=\.tho_fix_thing_2$' "$android" \
  && pass "Android applicationIdSuffix is a valid package segment" \
  || fail "Android applicationIdSuffix wrong: $(cat "$android")"
printf '%s' "$out" | grep -q 'Worktree: Fix_Thing-2' \
  && pass "worktree run reports the label" \
  || fail "worktree run must report the label, got: $out"

# ── Worktree: digit-leading branch gets a letter-prefixed Android segment ────
wt2="$tmp/wt-digit"
git -C "$repo" worktree add -q -b "2fast" "$wt2"
mkdir -p "$wt2/scripts" "$wt2/mobile/ios/Flutter" "$wt2/mobile/android"
cp "$script" "$wt2/scripts/mobile-worktree-env.sh"
"$wt2/scripts/mobile-worktree-env.sh" > /dev/null
grep -q '^applicationIdSuffix=\.w_2fast$' "$wt2/mobile/android/worktree.properties" \
  && pass "digit-leading branch yields a valid Android package segment" \
  || fail "digit-leading branch segment wrong: $(cat "$wt2/mobile/android/worktree.properties")"

# ── Tracked build files: overrides are debug-only, release stays production ──
debug_xcconfig="$repo_root/mobile/ios/Flutter/Debug.xcconfig"
release_xcconfig="$repo_root/mobile/ios/Flutter/Release.xcconfig"
gradle="$repo_root/mobile/android/app/build.gradle.kts"
manifest="$repo_root/mobile/android/app/src/main/AndroidManifest.xml"
plist="$repo_root/mobile/ios/Runner/Info.plist"

grep -q 'WorktreeOverrides.xcconfig' "$debug_xcconfig" \
  && pass "Debug.xcconfig includes WorktreeOverrides" \
  || fail "Debug.xcconfig must include WorktreeOverrides.xcconfig"
grep -q 'WorktreeOverrides' "$release_xcconfig" \
  && fail "Release.xcconfig must not include WorktreeOverrides.xcconfig" \
  || pass "Release.xcconfig does not include WorktreeOverrides"
grep -q '^BUNDLE_IDENTIFIER = com\.buzz\.buzzMobile$' "$release_xcconfig" \
  && pass "Release.xcconfig keeps the production bundle identifier" \
  || fail "Release.xcconfig must keep BUNDLE_IDENTIFIER = com.buzz.buzzMobile"
grep -q '^APP_DISPLAY_NAME = Buzz$' "$release_xcconfig" \
  && pass "Release.xcconfig keeps the production display name" \
  || fail "Release.xcconfig must keep APP_DISPLAY_NAME = Buzz"
grep -q '<string>$(APP_DISPLAY_NAME)</string>' "$plist" \
  && pass "Info.plist display name resolves from build settings" \
  || fail "Info.plist CFBundleDisplayName must be \$(APP_DISPLAY_NAME)"
grep -q 'android:label="@string/app_name"' "$manifest" \
  && pass "Android manifest label resolves from resources" \
  || fail "Android manifest label must be @string/app_name"
grep -q 'resValue("string", "app_name", "Buzz")' "$gradle" \
  && pass "Gradle default app_name stays Buzz" \
  || fail "Gradle must declare the default app_name resValue"
# The worktree suffix/label must only appear inside the debug build type.
awk '/buildTypes \{/,/^\}/' "$gradle" | awk '/release \{/,/\}/' | grep -q 'worktree' \
  && fail "release build type must not reference worktree identity" \
  || pass "release build type does not reference worktree identity"
git -C "$repo_root" check-ignore -q mobile/ios/Flutter/WorktreeOverrides.xcconfig \
  && pass "iOS override file is gitignored" \
  || fail "mobile/ios/Flutter/WorktreeOverrides.xcconfig must be gitignored"
git -C "$repo_root" check-ignore -q mobile/android/worktree.properties \
  && pass "Android override file is gitignored" \
  || fail "mobile/android/worktree.properties must be gitignored"
grep -Eq '^\s+\./scripts/mobile-worktree-env\.sh$' "$repo_root/Justfile" \
  && pass "just mobile-dev applies the worktree identity" \
  || fail "Justfile mobile-dev must run scripts/mobile-worktree-env.sh"

if [[ "$failures" -gt 0 ]]; then
  printf '%d failure(s)\n' "$failures" >&2
  exit 1
fi
printf 'all mobile worktree identity contract checks passed\n'
