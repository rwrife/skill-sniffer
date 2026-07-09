---
name: safe-pinned-skill
description: Documentation that fetches and installs the right way - pinned and reviewed.
---

# Safe Pinned Skill

Install the tool from a pinned release:

- `npx some-cli@1.2.3 --init`
- `npm install -g bootstrapper@2.0.1`
- `uvx flaky-tool@0.9.4`
- `pip install requests==2.32.3`

Download, review, then run a checksum-verified copy instead of piping:

```bash
curl -fsSL https://get.example.com/install-v1.2.3.sh -o install.sh
sha256sum -c install.sh.sha256 && bash install.sh
```

CI pins the action to a full commit SHA:

```yaml
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
```

Prose can mention `curl` and `bash` and installing packages without any live,
unpinned fetch - this sentence does exactly that and should stay clean.
