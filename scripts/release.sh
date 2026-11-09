#!/usr/bin/env bash
# Prepare a ServCrafty release: bump versions, commit, tag. Does NOT push.
#
#   scripts/release.sh patch|minor|major|X.Y.Z[-pre]
#
# Bumps "version" in package.json, server/package.json and web/package.json
# (and the matching entries of server/ and web/ package-lock.json), commits
# "Release vX.Y.Z" and creates the annotated tag vX.Y.Z. Pushing the tag runs
# .github/workflows/release.yml (image + GitHub release).
set -Eeuo pipefail

die() { echo "release: $*" >&2; exit 1; }

[[ $# -eq 1 ]] || die "usage: $0 patch|minor|major|X.Y.Z"
root="$(git rev-parse --show-toplevel)"
cd "$root"

command -v node >/dev/null || die "node is required"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "working tree has uncommitted changes"

current="$(node -p "require('./server/package.json').version")"
# shellcheck disable=SC2016  # JavaScript source, not shell
next="$(node -e '
  const [cur, bump] = process.argv.slice(1);
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(cur);
  if (!m) { console.error(`current version ${cur} is not semver`); process.exit(1); }
  let [ma, mi, pa] = m.slice(1).map(Number);
  const pre = /-/.test(cur);
  if (bump === "major") { ma++; mi = 0; pa = 0; }
  else if (bump === "minor") { mi++; pa = 0; }
  else if (bump === "patch") { if (!pre) pa++; }
  else if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(bump)) { process.stdout.write(bump); process.exit(0); }
  else { console.error(`unknown bump "${bump}"`); process.exit(1); }
  process.stdout.write(`${ma}.${mi}.${pa}`);
' "$current" "$1")"
tag="v$next"

[[ "$next" != "$current" ]] || die "version is already $current"
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then die "tag $tag already exists"; fi

branch="$(git branch --show-current)"
[[ "$branch" == "main" ]] || echo "release: warning: releasing from branch '${branch:-detached}', not main" >&2

echo "Releasing $current -> $next"
node -e '
  const fs = require("fs");
  const next = process.argv[1];
  const bump = (file, lock) => {
    if (!fs.existsSync(file)) return;
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    j.version = next;
    if (lock && j.packages && j.packages[""]) j.packages[""].version = next;
    fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
    console.log("  updated " + file);
  };
  for (const f of ["package.json", "server/package.json", "web/package.json"]) bump(f, false);
  for (const f of ["package-lock.json", "server/package-lock.json", "web/package-lock.json"]) bump(f, true);
' "$next"

files=(package.json server/package.json web/package.json)
for f in package-lock.json server/package-lock.json web/package-lock.json; do
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then files+=("$f"); fi
done
git add -- "${files[@]}"
git commit -q -m "Release $tag"
git tag -a "$tag" -m "ServCrafty $tag"

echo
echo "Created commit and tag $tag. Review, then publish with:"
echo "  git push origin ${branch:-HEAD} $tag"
