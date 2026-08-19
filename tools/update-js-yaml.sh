#!/usr/bin/env bash
set -euo pipefail

readonly VERSION=4.1.0
readonly DIST_SHA256=16f210b939b359b6ec8dde581eb62c157185711dc7b719b33779c43db5c31a91
readonly LICENSE_SHA256=a07bc24468b9654ce76a547d47a2db282d07733b715db4c73a98bd63961f9550
readonly OUTPUT_DIR=${1:-/tmp/mpris-lyrics-js-yaml-${VERSION}}

mkdir -p "${OUTPUT_DIR}"
curl -fsSL "https://raw.githubusercontent.com/nodeca/js-yaml/${VERSION}/dist/js-yaml.mjs" \
    -o "${OUTPUT_DIR}/js-yaml.mjs"
curl -fsSL "https://raw.githubusercontent.com/nodeca/js-yaml/${VERSION}/LICENSE" \
    -o "${OUTPUT_DIR}/LICENSE.js-yaml"

printf '%s  %s\n' "${DIST_SHA256}" "${OUTPUT_DIR}/js-yaml.mjs" | sha256sum -c -
printf '%s  %s\n' "${LICENSE_SHA256}" "${OUTPUT_DIR}/LICENSE.js-yaml" | sha256sum -c -
printf 'Verified js-yaml %s in %s\n' "${VERSION}" "${OUTPUT_DIR}"
