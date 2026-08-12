#!/usr/bin/env bash
#
# Builds the zip to upload to the Chrome Web Store.
#
# The repo holds the extension, the server and the website together, which is
# convenient to work in and wrong to upload: the store wants the extension and
# nothing else. Anything extra is a bigger download for every user, and a larger
# surface for a reviewer to ask about.
#
#   ./package-extension.sh
#
set -euo pipefail

cd "$(dirname "$0")"

VERSION=$(node -p "require('./manifest.json').version")
OUT="dist/yt-summariser-${VERSION}.zip"

# Exactly what the extension needs at runtime. An allowlist, not an ignore list:
# a new server file or secret should never be able to end up in a release
# because someone forgot to exclude it.
INCLUDE=(
  manifest.json
  background
  content
  options
  icons
)

echo "Packaging version ${VERSION}"

for path in "${INCLUDE[@]}"; do
  if [[ ! -e "$path" ]]; then
    echo "  MISSING: $path" >&2
    exit 1
  fi
done

# The store rejects a manifest that declares files which are not in the zip, and
# that failure arrives after upload rather than now.
node - <<'CHECK'
const fs = require('fs');
const m = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const referenced = [
  ...Object.values(m.icons || {}),
  ...Object.values((m.action || {}).default_icon || {}),
  m.options_page,
  (m.background || {}).service_worker,
  ...(m.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
].filter(Boolean);

const missing = referenced.filter((p) => !fs.existsSync(p));
if (missing.length) {
  console.error('  manifest references files that do not exist:');
  missing.forEach((p) => console.error('    ' + p));
  process.exit(1);
}
console.log(`  manifest references ${referenced.length} files, all present`);
CHECK

# A key in the manifest is required for local development - it is what pins the
# extension id so OAuth keeps working - and is REJECTED outright by the store
# ("key field is not allowed in manifest"). It is stripped from the package
# below, not from the working tree.
if node -p "!!require('./manifest.json').key" | grep -q true; then
  echo "  note: manifest has a pinned key (kept for local dev, stripped from the package)"
fi

rm -rf dist/package "$OUT"
mkdir -p dist/package

for path in "${INCLUDE[@]}"; do
  cp -R "$path" dist/package/
done

# macOS sprinkles these through any copied tree and they end up in the zip.
find dist/package -name '.DS_Store' -delete

# The localhost host permission exists so a developer can point the extension at
# a local server through the Advanced setting. Nobody installing from the store
# can use it, and a public extension asking for access to the user's own machine
# is a reasonable thing for a reviewer to stop and ask about. Stripped from the
# package only - the working tree keeps it, so local development is unaffected.
node - <<'STRIP'
const fs = require('fs');
const path = 'dist/package/manifest.json';
const m = JSON.parse(fs.readFileSync(path, 'utf8'));
const before = (m.host_permissions || []).length;
m.host_permissions = (m.host_permissions || []).filter((h) => !/localhost|127\.0\.0\.1/.test(h));
console.log(
  `  host_permissions: ${before} -> ${m.host_permissions.length} (localhost stripped for release)`
);

// The store rejects an uploaded manifest that carries a key, and it assigns
// identity from the developer account anyway. Locally the key is what keeps the
// extension id - and therefore the OAuth redirect - stable, so it stays in the
// working tree and only ever leaves the package.
if (m.key) {
  delete m.key;
  console.log('  key: removed for release (the store rejects it; kept locally to pin the dev id)');
}

// The store caps the manifest description at 132 characters and refuses the
// upload past it, after the upload rather than before.
if ((m.description || '').length > 132) {
  console.error(`  description is ${m.description.length} chars, the store allows 132`);
  process.exit(1);
}

fs.writeFileSync(path, JSON.stringify(m, null, 2) + '\n');
STRIP

(cd dist/package && zip -qr "../$(basename "$OUT")" .)
rm -rf dist/package

echo
echo "  $OUT  ($(du -h "$OUT" | cut -f1))"
echo
# -Z1 lists bare names. `head -n -N` is a GNU extension and is not available on
# macOS, so don't reach for it to trim a table.
echo "Contents:"
unzip -Z1 "$OUT" | grep -v '/$' | sort | sed 's/^/  /'

echo
echo "Upload at https://chrome.google.com/webstore/devconsole"
