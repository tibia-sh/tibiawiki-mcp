# Releasing

`@tibia.sh/tibiawiki-mcp` is released by [release-please](https://github.com/googleapis/release-please) and published by `.github/workflows/release.yml`, first to npm and then to the [MCP registry](https://registry.modelcontextprotocol.io) as `sh.tibia/tibiawiki-mcp`. The registry publish needs [a one-time setup](#setting-up-the-mcp-registry-publish).

## A normal release

1. A releasable commit, such as a `feat:` or a `fix:`, lands on `main`. The push runs `release.yml`, and its release-please step opens or updates the release PR, `chore(main): release X.Y.Z`, labelled `autorelease: pending`. The PR bumps the version in `package.json`, `server.json`, `.claude-plugin/plugin.json`, `.mcp.json` and `.release-please-manifest.json`, and adds the release notes to `CHANGELOG.md`.
2. release-please opens the PR with `GITHUB_TOKEN`, so its CI waits for you. Click **Approve workflows to run** in the merge box, and again after every update to the PR. `main` takes the merge only once the `test` check passes.

   You can also approve through the API, as `0.3.0` was. Put the `databaseId` of the run whose conclusion is `action_required` in place of `RUN_ID`:

   ```bash
   PR=N
   COMMIT=$(gh pr view "$PR" --json headRefOid --jq .headRefOid)
   gh run list --workflow ci.yml --commit "$COMMIT" --json databaseId,conclusion
   gh api -X POST repos/tibia-sh/tibiawiki-mcp/actions/runs/RUN_ID/approve
   ```

3. Merging the release PR publishes. The merge's push run creates the tag `vX.Y.Z` and the GitHub release at the merge commit, and relabels the PR `autorelease: tagged`. Then it checks out that commit, runs `pnpm install --frozen-lockfile` and `pnpm test`, and runs `npm publish` through npm trusted publishing. npm adds provenance for that commit when it confirms that the repository and the package are public. Once npm accepts the publish, the run's `registry` job checks out the tag, checks that `server.json` carries its version, waits until npm serves that version, and publishes `server.json` to the MCP registry.
4. The release is done when that run is green, its `npm publish` and `Publish to the MCP registry` steps ran, and both npm and the MCP registry list the version.

Only the run triggered at the merge commit publishes, because npm provenance names the commit that triggered the run. A run triggered at any other commit that creates the release fails red instead, at the step `Release tagged at another commit, not published`.

## Where to look

| What | Command |
|---|---|
| Release runs | `gh run list --workflow release.yml` |
| Earlier attempts of a run | `gh run view <run-id> --attempt <n>`, or the **Latest** menu on the run page |
| Versions on npm | `npm view @tibia.sh/tibiawiki-mcp versions --json` |
| Versions in the MCP registry | `curl -sS https://registry.modelcontextprotocol.io/v0.1/servers/sh.tibia%2Ftibiawiki-mcp/versions` |
| A GitHub release and its commit | `gh release view vX.Y.Z --json targetCommitish,isImmutable` |
| A release PR's labels and merge commit | `gh pr view <pr> --json labels,mergeCommit` |

Run `gh` from a checkout of this repository, or add `-R tibia-sh/tibiawiki-mcp`.

Read the whole version list. `npm view @tibia.sh/tibiawiki-mcp@X.Y.Z` exits 1 both for a version npm lacks and for a registry it cannot read. A new version can also be missing from the list for a few minutes. `0.1.0` took about 5 minutes to show up.

## A plain re-run publishes nothing

Re-running a release run that failed in a later step, after release-please created the GitHub release, turns the run green and publishes nothing. The failed attempt already created the release and relabelled the PR `autorelease: tagged`, so the re-run finds no release PR left to release. `release_created` stays unset, and every step after release-please is skipped. The red attempt is then only behind the **Latest** menu.

A green release run does not prove a publish. Check npm. The one re-run that publishes is [the recovery below](#re-run-the-merge-commits-run), after the release, the tag and the label are reset.

The same goes for a push run whose `registry` job failed. Re-running the whole run does not retry the registry publish. Its release job does not release that version again, so `released` stays empty and the `registry` job is skipped. Publish to the registry through [a dispatch](#a-version-the-mcp-registry-does-not-have) instead.

## A release npm does not have

The tag and the GitHub release exist, and `npm view @tibia.sh/tibiawiki-mcp versions --json` does not list the version.

| How it happened | What you see |
|---|---|
| The run for the merge commit failed or was cancelled after release-please created the release. npm was down, the trusted publisher did not match, or a test failed on the runner. | That run is red at the step that failed. A trusted publisher that does not match fails `npm publish` with `ENEEDAUTH`. |
| A run triggered at another commit reached the merged release PR first. Release runs wait their turn, and GitHub does not guarantee their order. | That run is red at `Release tagged at another commit, not published`, and its error names the tag and both commits. The merge commit's own run is green and published nothing. |
| Someone re-ran one of those runs. | The latest attempt is green, and the red one is behind the **Latest** menu. |

This is urgent. The release commit pinned `.mcp.json` to the new version, so the plugin on `main` cannot start until npm has it. While you follow either recovery below, merge nothing to `main`.

Set `VERSION` to the version npm does not have, and `PR` to the number of its release PR:

```bash
VERSION=X.Y.Z
PR=N
```

Two cases have no recovery, so check for them first. If `npm view @tibia.sh/tibiawiki-mcp versions --json` lists any version above `$VERSION`, leave `$VERSION` unpublished and retitle its release as in step 3 of [A bad release](#a-bad-release). Do not count on npm to stop a publish there. npm refuses it with `Cannot implicitly apply the "latest" tag` only when its own read of the registry shows that higher version, and the version is neither deprecated nor a prerelease. Otherwise the publish succeeds and moves `latest` to `$VERSION`. If `$VERSION` was on npm once and was unpublished, npm refuses it for good, so treat it as [A bad release](#a-bad-release).

If `pnpm test` failed, run steps 1 and 2 of [Publish by hand](#publish-by-hand) to test a clean checkout of the tag. If it fails there too, the tagged commit is bad, so go to [A bad release](#a-bad-release).

| Recovery | Provenance | Use it when |
|---|---|---|
| [Re-run the merge commit's run](#re-run-the-merge-commits-run) | as in a normal release | nothing in the repository has to change, the run is less than 30 days old and was re-run fewer than 50 times, and the release is not immutable |
| [Publish by hand](#publish-by-hand) | none | anything else |

Nothing in the repository has to change when npm is back up, the trusted publisher is fixed on npmjs.com, a test was flaky, or the runs started out of order.

### Re-run the merge commit's run

**Not yet exercised.** It follows the source of release-please 17.6.0, the version `release.yml` runs.

A re-run keeps the run's `GITHUB_SHA`. So when release-please creates the release again, the publish steps run, and any provenance names the merge commit. GitHub re-runs a run only [up to 30 days after its first attempt, and at most 50 times](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs). A run older than 30 days cannot be re-run at all, so publish by hand. The recovery deletes the tag for release-please to create again, and the tag name of an [immutable release](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases) can never be used again.

1. Check that the release is not immutable, and that no release run is waiting or running. The first command must print `false`, and the loop must print nothing:

   ```bash
   gh release view "v$VERSION" --json isImmutable --jq .isImmutable
   for state in requested queued pending waiting in_progress; do gh run list --workflow release.yml --status "$state" --json databaseId --jq '.[].databaseId'; done
   ```

   If the loop prints run IDs, wait until those runs finish, for example with `gh run watch <run-id>`. Then run both commands again, and go on only when they pass.

2. Find the merge commit and the run it triggered, and check that GitHub can still re-run it. `echo` must print a run ID, `createdAt` must be less than 30 days ago, and `attempt` must be 50 or lower:

   ```bash
   SHA=$(gh pr view "$PR" --json mergeCommit --jq .mergeCommit.oid)
   RUN=$(gh run list --workflow release.yml --commit "$SHA" --event push --json databaseId --jq '.[0].databaseId')
   echo "$RUN"
   gh run view "$RUN" --json createdAt,attempt
   ```

3. From here to step 5, work without a pause, and merge nothing to `main` until the re-run has finished. Delete the release and its tag. The second command must print nothing:

   ```bash
   gh release delete "v$VERSION" --cleanup-tag --yes
   git ls-remote --tags https://github.com/tibia-sh/tibiawiki-mcp.git "v$VERSION"
   ```

4. Label the PR pending again. The second command must print `autorelease: pending` and nothing else:

   ```bash
   gh pr edit "$PR" --remove-label "autorelease: tagged" --add-label "autorelease: pending"
   gh pr view "$PR" --json labels --jq '.labels[].name'
   ```

5. Re-run the merge commit's run, never the red run of another commit. Follow it on the run page or with `gh run watch "$RUN"`.

   ```bash
   gh run rerun "$RUN"
   ```

6. Check the result. The run is green with its `npm publish` and `Publish to the MCP registry` steps run, `gh release view "v$VERSION" --json targetCommitish` names `$SHA`, and the PR is back to `autorelease: tagged`. Once npm lists the version, run `pnpm smoke "@tibia.sh/tibiawiki-mcp@$VERSION"` in an installed checkout.

Any other release run that starts between steps 3 and 5 undoes this. After step 4 it creates the release itself, in a run triggered at the wrong commit, and you are back at the start. Before step 4 it opens or rewrites the release PR for a version past `$VERSION`, with the whole history as its notes. Left open, that PR can be merged while it shows the wrong version, and a later run quietly rewrites it into the next real release PR. So once the re-run has finished, find the open release PR whose title shows a version past `$VERSION`, and close it:

```bash
gh pr list --label "autorelease: pending" --json number,title
gh pr close N
```

Do not add `autorelease: snooze` to it, because release-please reopens and reuses a closed PR with that label. Closing loses nothing, since the next release run opens a fresh release PR when there is something to release.

If the re-run itself fails after release-please created the release, you are also back at the start of this section.

### Publish by hand

A publish from your machine carries no provenance and no trusted publisher. Never add an npm token to CI to get around that. `0.1.0` and `0.2.0` were published from a tarball like this. Where [the re-run](#re-run-the-merge-commits-run) applies, use it instead, because it keeps trusted publishing.

`0.3.0` came through trusted publishing, and the data repository's `pnpm-workspace.yaml` sets `trustPolicy: no-downgrade`. That setting makes pnpm refuse a version with weaker trust evidence than any version published before it. So the data repository can take a version you publish by hand as its devDependency only after it adds `trustPolicyExclude` for exactly `@tibia.sh/tibiawiki-mcp@X.Y.Z` to that file. Without the exclude, its install fails with `ERR_PNPM_TRUST_DOWNGRADE`.

```yaml
# @tibia.sh/tibiawiki-mcp X.Y.Z was published by hand, so it has no trusted publisher.
trustPolicyExclude:
  - '@tibia.sh/tibiawiki-mcp@X.Y.Z'
```

pnpm reads only the first entry that names a package, so keep one entry for it. Remove the exclude in the pull request that moves the devDependency to a later version released through the pipeline. Without the exclude, a lockfile still on the version you published by hand fails the next `pnpm dedupe`.

1. Clone the tag fresh, outside any working tree, and check that it is the release commit. The last two commands must print the same commit:

   ```bash
   git clone https://github.com/tibia-sh/tibiawiki-mcp.git "tibiawiki-mcp-$VERSION"
   cd "tibiawiki-mcp-$VERSION"
   git checkout "v$VERSION"
   git rev-parse HEAD
   gh pr view "$PR" --json mergeCommit --jq .mergeCommit.oid
   ```

2. Install and test. npm runs no lifecycle scripts when it publishes a tarball, `prepublishOnly` included, so this run is the only gate the publish gets.

   ```bash
   pnpm install --frozen-lockfile
   pnpm test
   ```

3. Pack, then read the file list and the integrity:

   ```bash
   npm pack --json > pack.json
   node -p 'Object.values(require("./pack.json"))[0].files.map(f => f.path).join("\n")'
   node -p 'Object.values(require("./pack.json"))[0].integrity'
   ```

   The list must hold only `dist/`, `data/spell-areas.json`, `package.json`, `README.md` and `LICENSE`.

4. Smoke the tarball. This is the last step you can take back.

   ```bash
   pnpm smoke "./tibia.sh-tibiawiki-mcp-$VERSION.tgz"
   ```

5. Log in, and publish the tarball, not the directory:

   ```bash
   npm login
   npm publish "./tibia.sh-tibiawiki-mcp-$VERSION.tgz"
   ```

   npm asks for your second factor, in the browser or as a one-time password. It prints `+ @tibia.sh/tibiawiki-mcp@X.Y.Z` once the registry accepts the publish.

6. Check that npm holds the bytes you read. This must print the integrity from step 3:

   ```bash
   npm view "@tibia.sh/tibiawiki-mcp@$VERSION" dist.integrity
   ```

   Once `npm publish` has printed its `+` line, an `E404` here only means the registry has not caught up. When it prints the integrity, run `pnpm smoke "@tibia.sh/tibiawiki-mcp@$VERSION"`.

7. Check that the PR carries `autorelease: tagged` and nothing else:

   ```bash
   gh pr view "$PR" --json labels --jq '.labels[].name'
   ```

   If release-please failed after creating the release, the PR can still carry `autorelease: pending`, and the next release run would fail once on the existing release. Move the label:

   ```bash
   gh pr edit "$PR" --remove-label "autorelease: pending" --add-label "autorelease: tagged"
   ```

8. A publish by hand runs no `registry` job. Publish the version to the MCP registry as in [A version the MCP registry does not have](#a-version-the-mcp-registry-does-not-have).

## A version the MCP registry does not have

**Not yet exercised.** It follows the source of the registry and `mcp-publisher` at `v1.8.1`, the version `release.yml` pins.

npm lists the version, and the MCP registry does not. Set `VERSION` and check both:

```bash
VERSION=X.Y.Z
npm view @tibia.sh/tibiawiki-mcp versions --json
curl -sS "https://registry.modelcontextprotocol.io/v0.1/servers/sh.tibia%2Ftibiawiki-mcp/versions/$VERSION"
```

The registry lacks the version when `curl` prints `"detail":"Server not found"`. When it has the version, `curl` prints its entry, with `"version":"X.Y.Z"` under `server`. For a version npm does not list, start at [A release npm does not have](#a-release-npm-does-not-have).

The registry reads the version from npm once and does not retry, so the `registry` job waits for npm to serve a new version before it logs in. A version npm is slow to serve still lands here when that wait runs out, or when the registry's own read of npm misses a version the wait saw.

| How it happened | What you see |
|---|---|
| The key is missing from the `mcp-registry` environment, or the TXT record on `tibia.sh` is missing or holds another key. | The release run is red at `Log in to the MCP registry`, with `private key (hex) is required`, `no MCP public key found in DNS TXT records` or `signature verification failed`. When the key is set, the step prints the TXT record it expects. |
| npm did not serve the version with `mcpName` `sh.tibia/tibiawiki-mcp` in 40 tries, 15 seconds apart. | The release run is red at `Wait for npm to serve the tag's version`, and its error names the version. |
| The registry failed or was down, or its own read of npm failed. | The release run is red at `Publish to the MCP registry`, with the registry's error, such as `Likely transient, retry later` for a failed read of npm. |
| The version reached npm through [Publish by hand](#publish-by-hand). | No `registry` job ran for the version. |

Dispatch the release workflow on `main` with the version's tag. It waits its turn behind any release run in progress.

```bash
gh workflow run release.yml --ref main -f tag="v$VERSION"
```

`gh` prints the URL of the run it started. Follow the run there, or with `gh run watch <run-id>`, where the run ID is the number at the end of the URL. If `gh` prints no URL, `gh run list --workflow release.yml --event workflow_dispatch` lists dispatched runs, newest first. Yours is the one created when you dispatched.

A dispatched run's release job skips release-please, so it releases nothing and publishes nothing to npm. Only its `registry` job acts. It checks out the tag, checks that `server.json` carries the version, waits until npm serves that version, and publishes it. A version npm already serves passes the wait on the first try.

Dispatch on `main` only. The key is a secret of the `mcp-registry` environment, which admits runs on `main` alone. The `registry` job of a run dispatched on any other branch or tag fails before its first step. The tag reaches the job as the input, never as the ref.

If the registry has the version already, `Publish to the MCP registry` fails with `cannot publish duplicate version`. That is expected, and nothing changed. The registry never takes a version twice. Registering an older version after a newer one is fine. The registry keeps the higher version as its latest.

The recovery is done when the run is green and the `curl` above prints the version.

If `Check that server.json carries the tag's version` fails, or the registry rejects the tag's `server.json`, the workflow cannot register that version. Leave it out of the registry, and fix `server.json` in the next release.

The same goes for a version npm serves with another `mcpName`, or none, because `Wait for npm to serve the tag's version` never passes for it. Before you dispatch again after that step failed, check what npm serves. This must print `sh.tibia/tibiawiki-mcp`:

```bash
curl -sS "https://registry.npmjs.org/@tibia.sh%2Ftibiawiki-mcp/$VERSION" | jq -r .mcpName
```

If it prints anything else, or `null`, leave the version out of the registry, and fix `mcpName` in `package.json` in the next release.

## A bad release

**Not yet exercised.** It follows the source of release-please 17.6.0.

The tagged commit has a defect. Release a patch. Do not delete the release and its tag to cut the same version again.

Leave the tag where it is. release-please finds the last release through the version in `.release-please-manifest.json`, by its GitHub release or else by its tag. With neither left, it counts every commit it can find as unreleased, and the next release PR bumps past that version with the whole history as its changelog.

Set `VERSION` to the bad version:

```bash
VERSION=X.Y.Z
```

If npm has the bad version, deprecate it now. npm never accepts a version number twice, even after an unpublish, per its [unpublish policy](https://docs.npmjs.com/policies/unpublish).

```bash
npm deprecate "@tibia.sh/tibiawiki-mcp@$VERSION" "<what is wrong>. Use the next version."
```

1. Land the fix on `main` as a `fix:` commit. release-please opens or updates the release PR for the next version.
2. Approve the PR's CI and merge it, as in [A normal release](#a-normal-release).
3. If npm does not have the bad version, retitle its GitHub release, so nobody takes it for a published one:

   ```bash
   gh release edit "v$VERSION" --title "v$VERSION, not on npm"
   ```

Until the patch is on npm, `.mcp.json` on `main` pins the bad version. When npm does not have that version, the plugin on `main` cannot start.

## Setting up the MCP registry publish

**Done 2026-09-13.** `v0.3.0` was registered that day through [A version the MCP registry does not have](#a-version-the-mcp-registry-does-not-have). If the key or the TXT record goes away, the `registry` job fails at `Log in to the MCP registry`, and every release lands in that section again.

The registry lets only the owner of `tibia.sh` publish `sh.tibia/tibiawiki-mcp`. The `registry` job proves ownership with an Ed25519 key. Its public key sits in a TXT record on `tibia.sh`, and its private key is the `MCP_PRIVATE_KEY` secret of the `mcp-registry` environment. You set this up once.

1. Check that the `mcp-registry` environment exists and admits runs on `main` only. The first command must print `true`, and the second `branch main` and nothing else:

   ```bash
   gh api repos/tibia-sh/tibiawiki-mcp/environments/mcp-registry --jq .deployment_branch_policy.custom_branch_policies
   gh api repos/tibia-sh/tibiawiki-mcp/environments/mcp-registry/deployment-branch-policies --jq '.branch_policies[] | "\(.type) \(.name)"'
   ```

2. Install OpenSSL 3. The `openssl` macOS ships is LibreSSL, which fails with `Algorithm Ed25519 not found`.

   ```bash
   brew install openssl@3
   OPENSSL="$(brew --prefix openssl@3)/bin/openssl"
   ```

3. Generate the key, in a directory outside any working tree:

   ```bash
   "$OPENSSL" genpkey -algorithm Ed25519 -out key.pem
   ```

4. Print the TXT record:

   ```bash
   echo "v=MCPv1; k=ed25519; p=$("$OPENSSL" pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
   ```

   Add it to the DNS zone of `tibia.sh` as a TXT record on `tibia.sh` itself, next to the SPF record. The registry does not look under a subdomain such as `_mcp-auth.tibia.sh`.

5. Check that the record resolves. The output must hold the line from step 4 next to the SPF record. The zone's TXT records have a 5 minute TTL, so a resolver can take that long to show it.

   ```bash
   dig +short TXT tibia.sh
   ```

6. Store the private key as the secret, in the form `mcp-publisher` takes: the hex of the key's 32-byte seed. The commands pipe it into `gh`, so it is never shown, pasted or written to your shell history. They set nothing unless the hex is 64 characters long, and `gh` confirms with `Set Actions secret MCP_PRIVATE_KEY`.

   ```bash
   PRIVATE_KEY="$("$OPENSSL" pkey -in key.pem -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n')"
   [ "${#PRIVATE_KEY}" -eq 64 ] && printf '%s' "$PRIVATE_KEY" | gh secret set MCP_PRIVATE_KEY --env mcp-registry --repo tibia-sh/tibiawiki-mcp
   unset PRIVATE_KEY
   ```

7. Delete `key.pem`, or keep it where only you can read it, such as a password manager. GitHub never shows the secret again. Without `key.pem`, replacing the secret means a new key, and a new TXT record in place of the old one.

8. Publish the current release to the registry, as in [A version the MCP registry does not have](#a-version-the-mcp-registry-does-not-have). If `Log in to the MCP registry` fails with `signature verification failed`, compare the TXT record that step prints with the output of step 5. Once the run is green, record the date at the top of this section.

## Known future break

GitHub's REST API version `2026-03-10` drops `merge_commit_sha` from pull request responses, per [`data/reusables/rest-api/breaking-changes-changelog.md`](https://github.com/github/docs/blob/main/data/reusables/rest-api/breaking-changes-changelog.md) in github/docs. release-please 17.6.0 finds the release commit through that field, so without it a merged release PR creates no release, and the run still ends green. release-please sends no API version header, so it gets `2022-11-28`, which GitHub serves to such requests until 24 months after `2026-03-10`, around March 2028. Upgrade release-please-action to a release that handles this before then, and treat a merged release PR that gets no tag as the symptom.
