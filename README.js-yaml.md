# Vendored dependency

`js-yaml.mjs` is the readable ESM distribution of js-yaml 4.1.0. It is
bundled because GNOME Shell's GJS runtime has no YAML parser and must not depend
on Node.js or npm at runtime.

- Upstream: https://github.com/nodeca/js-yaml
- Version: 4.1.0
- License: MIT, retained in `LICENSE.js-yaml`
- `js-yaml.mjs` SHA-256:
  `16f210b939b359b6ec8dde581eb62c157185711dc7b719b33779c43db5c31a91`
- `LICENSE.js-yaml` SHA-256:
  `a07bc24468b9654ce76a547d47a2db282d07733b715db4c73a98bd63961f9550`

Run `tools/update-js-yaml.sh` to reproduce and verify these files before
copying an intentional dependency update into this directory.
