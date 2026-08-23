#!/usr/bin/env bash
set -euo pipefail

readonly ARCHIVE=${1:?usage: check-package.sh EXTENSION_ZIP}
readonly TMP_DIR=$(mktemp -d)
trap 'rm -rf -- "${TMP_DIR}"' EXIT

unzip -t "${ARCHIVE}"
unzip -q "${ARCHIVE}" -d "${TMP_DIR}"

readonly REQUIRED_FILES=(
    metadata.json
    extension.js
    prefs.js
    stylesheet.css
    schemas/org.gnome.shell.extensions.mpris-lyrics.gschema.xml
    locale/zh_CN/LC_MESSAGES/mpris-lyrics@eureka.mo
    js-yaml.mjs
    LICENSE.js-yaml
    README.js-yaml.md
    LICENSE
)

for file in "${REQUIRED_FILES[@]}"; do
    if [[ ! -f "${TMP_DIR}/${file}" ]]; then
        printf 'Missing required package file: %s\n' "${file}" >&2
        exit 1
    fi
done

if unzip -Z1 "${ARCHIVE}" | rg -q \
    '(^|/)(\.git|tests|tools|docs|node_modules|build|dist)(/|$)|(^|/)(\.env|gschemas\.compiled$)'; then
    printf 'Package contains a development-only or forbidden file\n' >&2
    exit 1
fi

while IFS= read -r imported; do
    if [[ ! -f "${TMP_DIR}/${imported}" ]]; then
        printf 'Package import target is missing: %s\n' "${imported}" >&2
        exit 1
    fi
done < <(
    rg -o "from ['\"]\./[^'\"]+['\"]" "${TMP_DIR}" --glob '*.js' |
        sed -E "s/^.*from ['\"]\.\/([^'\"]+)['\"]$/\1/" |
        sort -u
)

printf 'Package content and runtime import checks passed\n'
