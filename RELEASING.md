# Releasing

This is the canonical procedure for cutting a NimbleBrain release. Follow it literally — commands are copy-pasteable, verification steps have expected outputs. Deviating means you are not following this runbook.

## 1. Versioning rules

Tags use SemVer 2.0.0 with a `v` prefix: `vMAJOR.MINOR.PATCH[-PRERELEASE]`.

| Tag shape | Example | Stability | `:latest` on GHCR? | GitHub Release marked pre-release? |
|---|---|---|---|---|
| No hyphen | `v0.4.0`, `v1.2.3` | Stable / GA | Yes, moves forward | No (gets "Latest" banner) |
| With hyphen | `v0.4.0-beta.1`, `v0.4.0-rc.1`, `v0.4.0-alpha.1` | Pre-release | No | Yes |

The workflow distinguishes using `contains(github.ref_name, '-')`. Do not introduce tag shapes that break this rule (never `v0.4.0.beta1` with a dot, never a GA tag with a hyphen).

**Pre-release sequence.** Use `-beta.N` for validation, `-rc.N` for final sign-off. Increment `N` monotonically within a base version. Do not reset or reuse numbers:

```
v0.4.0-beta.1 → v0.4.0-beta.2 → v0.4.0-rc.1 → v0.4.0
```

If a release is botched, bump to the next number rather than re-tagging — §6.

**`package.json` is a sentinel — do not bump.** It is pinned to `"version": "0.0.0-dev"` and stays there forever. The image is version-agnostic — the version is injected at **deploy time** via the `NB_VERSION` env (the platform chart sets it from the image tag), which is what lets a release promote the staging-verified image by retag instead of rebuilding. Builds without `NB_VERSION` (local dev, non-deployed) fall through to `pkg.version` and self-report `0.0.0-dev`, which is intentionally clearly-not-a-release. Bumping this field per release would re-introduce the drift bug PR #73 fixed.

## 2. Prerequisites

Before cutting a release, verify:

- You are in a clean clone of `NimbleBrainInc/nimblebrain`
- Local `main` fast-forwards cleanly from origin
- The CI workflow on the commit you're about to tag has succeeded (check `gh run list --workflow=ci.yml --branch=main --limit=1`)
- `gh auth status` reports authenticated
- No tag with your target version already exists

Do not cut a release if any of these fail. Fix the underlying issue first.

## 3. Cut the release

Replace `TAG` with your target (e.g. `v0.4.0-beta.3` or `v0.4.0`).

```bash
TAG=v0.4.0-beta.3

# Sync main and sanity-check
git checkout main
git pull origin main --ff-only
git log --oneline -3
git tag -l "$TAG"   # EXPECTED: empty output. Non-empty = tag exists, abort.

# Create an annotated tag — always -a, never lightweight
git tag -a "$TAG" -m "$TAG

One-line summary of what this release delivers or validates.
Optional second paragraph with more detail."

# Push the tag — this triggers .github/workflows/release.yml
git push origin "$TAG"

# Find the run and watch to completion
sleep 5
gh run list --workflow=release.yml --limit 1
# Copy the run ID from the first column, then:
gh run watch <run-id> --exit-status --interval 20
```

Typical workflow duration: 3–5 minutes. If the run fails, go to §6.

## 4. Verify outputs

After the workflow reports success, confirm four things. Run the commands; compare against the expected outputs.

### 4a. GitHub Release

```bash
gh release view "$TAG" --json tagName,isPrerelease,url
```

**Expected:**
- `tagName` matches `$TAG`
- `isPrerelease` is `true` for hyphenated tags, `false` for GA
- `url` is the release page

### 4b. GHCR platform image

The canonical runtime image is `nimblebrain-runtime`; `nimblebrain` is a
transitional alias carrying the same digest (verify it too until the alias is
retired).

```bash
gh api "/orgs/NimbleBrainInc/packages/container/nimblebrain-runtime/versions" \
  --jq ".[] | select(.metadata.container.tags | contains([\"$TAG\"])) | {tags: .metadata.container.tags, created: .created_at}"
```

**Expected:**
- Output contains exactly one entry
- `tags` includes `$TAG` and a 7-char git SHA
- For **stable** releases: `tags` also includes `"latest"`
- For **pre-release** tags: `tags` does NOT include `"latest"`

### 4c. GHCR web image

```bash
gh api "/orgs/NimbleBrainInc/packages/container/nimblebrain-web/versions" \
  --jq ".[] | select(.metadata.container.tags | contains([\"$TAG\"])) | {tags: .metadata.container.tags, created: .created_at}"
```

**Expected:** same pattern as platform image.

### 4d. Anonymous pull works (public OSS contract)

From a shell where you are NOT logged in to GHCR:

```bash
docker logout ghcr.io 2>/dev/null
docker pull "ghcr.io/nimblebraininc/nimblebrain-runtime:$TAG"
docker pull "ghcr.io/nimblebraininc/nimblebrain:$TAG"   # transitional alias
docker pull "ghcr.io/nimblebraininc/nimblebrain-web:$TAG"
```

**Expected:** both pulls succeed. A failure here with "not found" or "denied" for a newly-created image name means §5 is needed.

If any of 4a–4d fail, go to §6.

## 5. One-time visibility flip for new image names

When a *new* image name is first published to GHCR (not a new version of an existing name), GitHub creates the package as **private** by default. The public `docker pull` in §4d will fail until the package is flipped to public.

This is needed exactly once per image name, then never again.

Current image names:
- https://github.com/orgs/NimbleBrainInc/packages/container/nimblebrain-runtime/settings — **NEW** (canonical runtime name); flip to public on its first release
- https://github.com/orgs/NimbleBrainInc/packages/container/nimblebrain/settings — already public (transitional alias)
- https://github.com/orgs/NimbleBrainInc/packages/container/nimblebrain-web/settings — already public

To flip: visit the settings URL → "Danger Zone" section → "Change visibility" → Public → confirm.

**Skip this section** unless §4d fails with an access/not-found error for a newly-introduced image name.

## 6. Rolling back a botched release

If verification fails or the release is broken, tear down everything associated with the tag and cut a new one with the next number. Do not try to fix in place.

```bash
TAG=v0.4.0-beta.3   # the botched tag

# 1. Delete local and remote git tag
git tag -d "$TAG"
git push origin ":refs/tags/$TAG"

# 2. Delete the GitHub Release (also deletes the remote tag if still present)
gh release delete "$TAG" --yes --cleanup-tag

# 3. Delete the GHCR package versions for every image.
#    First, list IDs of versions that carry this tag:
gh api "/orgs/NimbleBrainInc/packages/container/nimblebrain-runtime/versions" \
  --jq ".[] | select(.metadata.container.tags | contains([\"$TAG\"])) | .id"
# Then for each ID:
gh api -X DELETE "/orgs/NimbleBrainInc/packages/container/nimblebrain-runtime/versions/<id>"
# Repeat the two commands above for `nimblebrain` (the alias) and `nimblebrain-web`.

# 4. Delete ECR images for the botched tag (requires AWS CLI + credentials):
aws ecr batch-delete-image \
  --repository-name nimblebrain/nimblebrain-runtime \
  --image-ids "imageTag=$TAG" \
  --region us-east-1
aws ecr batch-delete-image \
  --repository-name nimblebrain/nimblebrain-web \
  --image-ids "imageTag=$TAG" \
  --region us-east-1
```

Then fix the underlying issue on `main` and cut the **next** pre-release number (e.g. if `v0.4.0-beta.3` was botched, next is `v0.4.0-beta.4`). Do not reuse the deleted tag number; issue references and CHANGELOG entries remain readable.

## 7. Workflow reference

`.github/workflows/release.yml` fires on any `v*` tag push (and `workflow_dispatch` with a `tag` input + an EMERGENCY `rebuild` toggle) and runs three jobs:

1. **Promote release images** — **promote-by-retag, not rebuild.** `ci.yml` already built and pushed the staging-verified runtime + web `:<sha>` images to ECR on merge; this re-tags those exact manifests to `:vX.Y.Z` via `aws ecr put-image` (guarded: target repo must be IMMUTABLE, the `:<sha>` source must exist, and a re-run is idempotent — same digest skips, a different digest fails). It then copies the same `:<sha>` manifests to the GHCR tags with `docker buildx imagetools create` (edge never pushes GHCR), and for stable releases moves `:latest`. There is no Verify or rebuild step — `ci.yml` already gated the commit, and the source-image-exists guard proves it. The `workflow_dispatch` `rebuild=true` escape hatch rebuilds from source instead (loud warning: prod won't be byte-for-byte) — only for a tag off a commit that never rode staging.
2. **GitHub Release** — creates a release with auto-generated notes; `prerelease` flag mirrors the hyphen rule
3. **Promote to prod (stable channel)** — GA only; dispatches the deploy-config receiver to record the new prod stable image tag, which the auto-sync per-tenant ApplicationSet then rolls. No-ops when the prod-promote App isn't configured (forks/pre-setup CI).

Artifact map:

| Registry | Repo | Tags on every release | Extra tags for stable only |
|---|---|---|---|
| GHCR (public) | `ghcr.io/nimblebraininc/nimblebrain-runtime` | `$TAG`, short-sha | `latest` |
| GHCR (public) | `ghcr.io/nimblebraininc/nimblebrain` (transitional alias) | `$TAG`, short-sha | `latest` |
| GHCR (public) | `ghcr.io/nimblebraininc/nimblebrain-web` | `$TAG`, short-sha | `latest` |
| ECR (private) | `nimblebrain/nimblebrain-runtime` | `$TAG` | — |
| ECR (private) | `nimblebrain/nimblebrain-web` | `$TAG` | — |

ECR repositories have immutable tags enabled — `:latest` is deliberately not pushed there; deploys pin to version or sha. ECR and GHCR repo names now match (`nimblebrain-runtime`, `nimblebrain-web`). `ghcr.io/nimblebraininc/nimblebrain` is a transitional alias for the runtime image kept so existing OSS pulls don't break; drop it once consumers have moved.

## 8. Out of scope for this runbook

These are things you might be tempted to do during a release but should NOT unless explicitly requested:

- **Do not** bump `package.json` version per release. The git tag is the authoritative version; bumping `package.json` adds PR churn without value.
- **Do not** edit CHANGELOG during a release — GitHub auto-generates release notes from merged PR titles.
- **Do not** deploy to production as part of cutting a release. Releasing publishes artifacts; deploying consumes them. Separate concerns, separate runbooks.
- **Do not** push `:latest` manually. The workflow gates this on stable releases; bypassing it defeats the gate.
