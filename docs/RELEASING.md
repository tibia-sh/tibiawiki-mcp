# Releasing

`@tibia.sh/tibiawiki-mcp` is released by [release-please](https://github.com/googleapis/release-please) and published by `.github/workflows/release.yml`, first to npm and then to the [MCP registry](https://registry.modelcontextprotocol.io) as `sh.tibia/tibiawiki-mcp`. The registry publish needs [a one-time setup](#setting-up-the-mcp-registry-publish).

## A normal release

1. A releasable commit, such as a `feat:` or a `fix:`, lands on `main`. The push runs `release.yml`, whose `please` job runs release-please as the `tibia-sh-bot` GitHub App. It opens or updates the release PR, `chore(main): release X.Y.Z`, labelled `autorelease: pending`. The PR bumps the version in `package.json`, `server.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.mcp.json` and `.release-please-manifest.json`, and adds the release notes to `CHANGELOG.md`.
2. The App opens the PR, so its CI runs, which it would not for a PR opened with `GITHUB_TOKEN`. The `please` job's step `Turn on auto-merge for the release PR` turns on the PR's auto-merge, unless it is on already, so the PR is added to the merge queue once the `test` check passes, and the queue merges it, as [The merge queue](#the-merge-queue) describes.

   If the merge box shows **Approve workflows to run** instead, the PR's CI is waiting for you. Click it, and again after every update to the PR. You can also approve through the API, as `0.3.0` was. Put the `databaseId` of the run whose conclusion is `action_required` in place of `RUN_ID`:

   ```bash
   PR=N
   COMMIT=$(gh pr view "$PR" --json headRefOid --jq .headRefOid)
   gh run list --workflow ci.yml --commit "$COMMIT" --json databaseId,conclusion
   gh api -X POST repos/tibia-sh/tibiawiki-mcp/actions/runs/RUN_ID/approve
   ```

3. The merge publishes. The merge's push run creates the tag `vX.Y.Z` and the GitHub release at the merge commit in its `please` job, and relabels the PR `autorelease: tagged`. Then its `release` job checks out that commit, runs `pnpm install --frozen-lockfile` and `pnpm test`, and runs `npm publish` through npm trusted publishing. npm adds provenance for that commit when it confirms that the repository and the package are public. Once npm accepts the publish, the run's `registry` job checks out the tag, checks that `server.json` carries its version, and waits until npm serves that version. Then one step, `Publish to the MCP registry`, publishes `server.json` to the MCP registry in up to three attempts, 30 seconds apart. Each attempt runs its own login. Beside the `registry` job, the run's `hosting` job tells `tibia-sh/mcp.tibia.sh` about the release, and that repository pins the version and deploys it, as [The hosting dispatch](#the-hosting-dispatch) describes.
4. The release is done when that run is green, its `npm publish` and `Publish to the MCP registry` steps ran, and both npm and the MCP registry list the version.

Only the run triggered at the merge commit publishes, because npm provenance names the commit that triggered the run. A run triggered at any other commit that creates the release fails red instead, at the step `Release tagged at another commit, not published`.

## The merge queue

`main` takes changes only through its merge queue. The maintainer adds the queue rule to the `main` ruleset, with the rebase merge method and one PR per group, right after the change that made `ci.yml` run on `merge_group` merges. Every merge, a bot's or a person's, is added to the queue, which tests it on top of the latest `main`, one PR per group, and merges it with a rebase only once the required `test` check passes there too. `ci.yml` runs on `merge_group` for that.

Passing tests on top of `main` does not make a release PR current, though. When a release PR waits in the queue behind another PR, the queue tests the release PR on top of the other one and merges the other one first, and the release PR's version and changelog miss the PR that just merged. So on `merge_group` the `test` job's step `Keep a release PR older than main out of the queue` fails an entry that changes `.release-please-manifest.json` unless the PR's head commit sits directly on the merge group's base, as release-please builds it, and the entry has exactly that head's tree. Only release PRs change that file. The merge group's ref, `gh-readonly-queue/main/pr-<number>-<base sha>`, names the PR and that base, and the step reads the PR's current head from `refs/pull/<number>/head`. So an entry the queue built from an older head, before release-please rebuilt the PR, fails too. That still passes a release PR computed from an older `main`, though. release-please works out the version and changelog from `main` as it first reads it, then commits them onto `main`'s head as it reads it again, so a PR that merges in between becomes the release PR's parent without showing in its notes. So the step also requires the newest `release` run for the push of the merge group's base, by run number, to have completed with `success`. It reads that run with the `test` job's `actions: read`. That run's `please` job ran release-please on the base, and with `always-update` release-please force-pushed the release PR with notes computed from the base. While that run is missing, as a push's run can be for a moment, or has not completed, the step reads it again every 20 seconds, for up to 20 minutes of waiting, and each read gives up after 60 seconds. Once the run has succeeded, the step reads the PR's head from `refs/pull/<number>/head` again, and it still has to sit on the base with the entry's tree. A push of the PR before the queue built the entry gave the entry the new head's tree, or fails the first check. A push during the wait fails the second, since GitHub does not document that a push takes a queued PR out of the queue at once. A later push can only come from a release run that reads `main` at the base too, since `main` moves only through the queue. The `test` job sets no `timeout-minutes`, so GitHub's default job limit of 6 hours leaves room for the wait. The entry fails when the run completed without `success`, when it has not completed after the 20 minutes, and at once when the step cannot read the run. The PR then leaves the queue. A run still going at the deadline rebuilds the PR itself if its `please` job has not run yet. Otherwise, on the next push to `main`, release-please rebuilds it as one commit on `main`'s tip, because `release-please-config.json` sets `always-update`. Without it, release-please leaves an open release PR alone while its notes stay the same, as they do after a `ci:`, `docs:` or `chore:` merge. The `please` job then turns the PR's auto-merge on unless it is still on, and the PR joins the queue again once its checks pass. So a release PR can never merge stale, and the merge's push run is the one that releases it.

A PR joins the queue once its own `test` check passes and someone, or its auto-merge, adds it. `gh pr merge <pr>` adds it, or turns on its auto-merge while its checks are still running. The queue sets the merge method, so a method flag such as `--rebase` only makes `gh` warn.

### The first release PR through the queue

The step reads the merge group's ref in its full form, `refs/heads/gh-readonly-queue/…`, as GitHub's webhook schema describes it: "The full ref of the merge group". No run of this repository has shown the value yet, so check the first release PR that goes through the queue. Its merge group's `test` run prints `The release PR was built on <sha>, the commit this queue entry merges onto.` in the step `Keep a release PR older than main out of the queue`.

If the ref arrives in another form, such as without `refs/heads/`, the step fails closed. It refuses every release PR with `The merge group's ref names no pull request and base commit`, so no release PR merges and nothing is published. The alert does not fire for it, because `alert.yml` watches only `release` and `generator` runs, and a release PR that leaves the queue fails neither. What you see instead is the release PR leaving the queue after every push to `main`, with that error in its merge group's `test` run. Fix the ref pattern in `ci.yml` in a PR of its own. That PR changes no manifest, so the step lets it through, and the release PR goes through on the push after it merges.

The step's read of `main`'s release run has not run live yet either. If the `test` job's token cannot read it, the step refuses every release PR the same way, with `Could not read main's release run for <sha>`, and the alert does not fire for that either. Check the job's `actions: read` and the query in `ci.yml`, and fix them in a PR of their own.

## A release without a fix or a feature

release-please opens a release PR only for a releasable commit. A `docs:` or a `chore:` is not one, so a README that changed stays off the npm page until the next `fix:` or `feat:`. To release anyway, land a commit whose message ends with a `Release-As` footer naming the version:

```text
docs: say how to release without a fix or a feature

Release-As: 0.6.3
```

Add its PR to the merge queue, which merges it with a rebase and keeps the message as it is. The push opens the release PR for that version, and from there it is [A normal release](#a-normal-release). `0.6.3` was released this way, to publish the README written for visitors.

## Where to look

| What | Command |
|---|---|
| Release runs | `gh run list --workflow release.yml` |
| Earlier attempts of a run | `gh run view <run-id> --attempt <n>`, or the **Latest** menu on the run page |
| Versions on npm | `npm view @tibia.sh/tibiawiki-mcp versions --json` |
| Versions in the MCP registry | `curl -sS https://registry.modelcontextprotocol.io/v0.1/servers/sh.tibia%2Ftibiawiki-mcp/versions` |
| A GitHub release and its commit | `gh release view vX.Y.Z --json targetCommitish,isImmutable` |
| A release PR's labels and merge commit | `gh pr view <pr> --json labels,mergeCommit` |
| Generator runs, and their open pull requests | `gh run list --workflow generator.yml`, `gh pr list --json number,headRefName --jq '.[] \| select(.headRefName \| startswith("generator/"))'` |

Run `gh` from a checkout of this repository, or add `-R tibia-sh/tibiawiki-mcp`.

Read the whole version list. `npm view @tibia.sh/tibiawiki-mcp@X.Y.Z` exits 1 both for a version npm lacks and for a registry it cannot read. A new version can also be missing from the list for a few minutes. `0.1.0` took about 5 minutes to show up.

## A new generator release

`build-index` runs the generator release that `GENERATOR_VERSION` and `GENERATOR_SHA256` in `src/indexer/build-index.ts` pin, as [The generator](MAINTAINING.md#the-generator) in `docs/MAINTAINING.md` describes. `.github/workflows/generator.yml` moves that pin. When `tibia-sh/tibiawiki-sql` publishes a release, its release workflow sends a `repository_dispatch` of type `generator-release` with `{"version": "X.Y.Z+tibiash.N"}`, which starts it. A maintainer can start it by hand with the version too. Runs take turns, and a waiting run is never replaced.

1. The `prepare` job holds no App token and names no environment. It checks the version whole, downloads the wheel and runs `gh attestation verify` on it with `github.token`, on every run, whatever the decision. Then `node scripts/set-generator.ts decide <version>` fetches `main`, reads its pin there, reads this repository's open pull requests from `generator/*` branches, and decides:
   - `noop` when `main` pins the version, when its pull request is open with auto-merge on, or when a newer version's pull request is open. The run ends green.
   - `refuse` when the version is below `main`'s pin. The run fails, and `alert.yml` comments on the issue.
   - `rearm` when its pull request is open with auto-merge off, as a run interrupted after it opened the pull request leaves it.
   - `propose` otherwise. The job installs, runs `node scripts/set-generator.ts set <version>` and `pnpm lock-generator`, which verifies the attestation again and writes the lock, runs `pnpm test`, and hands on `build-index.ts` and the lock with their sha256.
2. The `propose` job runs in the `release-trigger` environment and installs nothing. It runs `decide` again, and ends green with nothing done when `main` moved meanwhile, such as a newer pin that landed. On `propose` it takes the two files only if they are the ones `prepare` hashed and change nothing but the two constants and the lock. It downloads the wheel itself and verifies its attestation, requires the lock's generator entry to hold that wheel's sha256 and nothing else, and requires `build-index.ts` to be byte for byte the checked-out one with the version and that sha256. Only then does it mint the App's token, for this repository alone. It closes the pull requests for older versions with a comment. On `rearm` it only turns auto-merge back on. On `propose` it force-pushes `generator/<version>`, over a branch an interrupted run left, opens `fix: move the generator to <version>`, or reuses this repository's open one, and turns on auto-merge.
3. The pull request's CI checks the lock again, and the merge queue merges it. The merge releases a patch, as in [A normal release](#a-normal-release).

A generator pull request that waits in the queue behind other entries is fine. It changes no `.release-please-manifest.json`, so the queue check lets it through, and no stale-base rule applies to it.

### A failed generator run

`alert.yml` comments `generator failure: <run url>` on the issue. Read the run's red step, fix what it names, and start the workflow again by hand on `main` with the version:

```bash
gh workflow run generator.yml --ref main -f version=X.Y.Z+tibiash.N
```

The run decides afresh. A version `main` pins already, or whose pull request is open with auto-merge on, ends it green with nothing to do, and a pull request an earlier run left open with auto-merge off gets its auto-merge back. A version below `main`'s pin fails it again, which is right: nothing moves the pin backwards.

## Re-running a release run

GitHub re-runs a run in two ways, and since release-please and the publish run in separate jobs, they end differently.

- **Re-run all jobs**, `gh run rerun <run-id>`, runs every job again, `please` included. After a failed attempt that created the GitHub release, it publishes nothing. The failed attempt already relabelled the PR `autorelease: tagged`, so the re-run's `please` job finds no release PR left to release. `release_created` stays unset, so no step of the `release` job builds or publishes anything, `released` stays empty, and the `registry` and `hosting` jobs are skipped. The run turns green, unless another merged release PR still carries `autorelease: pending`, and the red attempt is then only behind the **Latest** menu.
- **Re-run failed jobs**, `gh run rerun <run-id> --failed`, runs only the jobs that failed and the jobs that need them, and hands them the outputs that the jobs which passed set in the failed attempt. After a failed `release` job, the re-run reuses the `please` job's outputs, so the `release` job runs its checks and the publish again for the release that attempt created, in the same run and at the same commit, and the `registry` and `hosting` jobs run once npm accepts it. After a failed `registry` or `hosting` job, the re-run runs that job again with the `release` job's outputs.

A green release run does not prove a publish. Check npm. A re-run of all jobs publishes only in [the recovery below](#re-run-the-merge-commits-run), after the release, the tag and the label are reset.

For a push run whose `registry` job failed, a re-run of all jobs does not retry the registry publish, because its `please` job does not release that version again, so `released` stays empty and the `registry` job is skipped. Publish to the registry through [a dispatch](#a-version-the-mcp-registry-does-not-have) instead.

## A failed please job

The `please` job runs release-please as the App, then turns on the release PR's auto-merge. When it is red, the jobs after it are skipped, so nothing was published. First find out whether release-please created a release before the job failed. Set `RUN` to the red run's ID, and look up the release of the version `.release-please-manifest.json` names at the run's commit:

```bash
RUN=N
SHA=$(gh run view "$RUN" --json headSha --jq .headSha)
VERSION=$(gh api "repos/tibia-sh/tibiawiki-mcp/contents/.release-please-manifest.json?ref=$SHA" --jq '.content | @base64d | fromjson | ."."')
gh release view "v$VERSION"
```

- `release not found`: nothing was created. Re-run the failed job with `gh run rerun "$RUN" --failed`. That is not a re-run of a release, because the run released nothing. The re-run keeps the run's commit, so a release it creates is published as in [A normal release](#a-normal-release).
- The release exists: never re-run the job. Check whether npm has the version with `npm view @tibia.sh/tibiawiki-mcp versions --json`. When it lists the version, the run's commit was not a release, and its manifest names the release before it, or that release was published already. Nothing is left to recover, and the next push to `main` runs release-please again and turns on the open release PR's auto-merge. To merge that PR before then, add it to the merge queue yourself with `gh pr merge <pr> --match-head-commit <its head commit>`. When npm does not list it, release-please created the release before a later step failed, so follow [A release npm does not have](#a-release-npm-does-not-have).

## A merged release PR with no release

The release PR is merged and still carries `autorelease: pending`. Its version has no tag and no GitHub release, and npm does not have it. Every push run that creates no release checks for this at `Check that every merged release PR was released`, and fails there with an error that names the PR.

release-please releases a merged PR only while it carries `autorelease: pending`, and moves the label to `autorelease: tagged` right after it creates the release. Until the label moves, release-please tries the PR again on every push and opens no new release PR. The step fails every push run that leaves the PR unreleased.

This is as urgent as [A release npm does not have](#a-release-npm-does-not-have). The release commit pinned `.mcp.json` to the new version, so the plugin on `main` cannot start until npm has it. It also pinned the marketplace entry to the release tag, so until that tag exists, installs and updates of the plugin from the marketplace fail.

Set `VERSION` to the version in the PR's title, and `PR` to its number:

```bash
VERSION=X.Y.Z
PR=N
```

The step can fail in a run other than the merge commit's own, because a run that waited its turn sees the PR as it is when the step runs. A later run can also release the PR before you look. So check that the state still holds. The first command must print `autorelease: pending`, and the second must print nothing:

```bash
gh pr view "$PR" --json labels --jq '.labels[].name'
git ls-remote --tags https://github.com/tibia-sh/tibiawiki-mcp.git "v$VERSION"
```

If the PR carries `autorelease: tagged` or the tag exists, a run released the PR after all. When `npm view @tibia.sh/tibiawiki-mcp versions --json` lists the version, nothing is left to do. When it does not, go to [A release npm does not have](#a-release-npm-does-not-have).

Otherwise, open the log of the `Run googleapis/release-please-action` step in the red run's `please` job, and find out why release-please did not release the PR:

| The log shows | Cause | Recovery |
|---|---|---|
| `Building release for path: .`, then `Pull request should have been merged` | GitHub no longer returns `merge_commit_sha`, as in [Known future break](#known-future-break). A re-run runs the same workflow file and the same release-please, so it stalls the same way. | [Create the release by hand](#create-the-release-by-hand) |
| `Building release for path: .`, then another message instead of `Creating 1 releases for pull #N`, such as `Bad pull request title` | release-please found the PR but cannot build a release from it. A re-run reads the same PR and stops the same way. | [Create the release by hand](#create-the-release-by-hand) |
| no `Building release for path: .` | A one-off miss. release-please did not find the PR when it looked for releases. The log can still show that it saw the PR later, as `Found pull request #N` right before `There are untagged, merged release PRs outstanding - aborting`. | [Re-run the merge commit's run](#re-run-the-merge-commits-run), with the changes below |

For a one-off miss, no release or tag exists, so skip the parts of [Re-run the merge commit's run](#re-run-the-merge-commits-run) that reset them. In step 1, run only the loop, not the `isImmutable` check. Skip steps 3 and 4. From step 2 until the re-run has finished, work without a pause and merge nothing to `main`. A push run that starts before the re-run can release the PR itself, in a run triggered at the wrong commit, and leave you at [A release npm does not have](#a-release-npm-does-not-have).

Step 2 finds the merge commit's run from the PR. Re-run that run even when the step failed in another run. Its 30 days count from its own `createdAt`, not from the run that failed. If GitHub can no longer re-run it, or the re-run fails at `Check that every merged release PR was released` again, [create the release by hand](#create-the-release-by-hand).

### Create the release by hand

**Not yet exercised.** It follows the source of release-please 17.6.0, the version `release.yml` runs, and of `gh` 2.100.0.

You create the tag and the GitHub release at the merge commit, as release-please would have, and then move the PR's label to `autorelease: tagged`. That leaves you at [A release npm does not have](#a-release-npm-does-not-have), where only [Publish by hand](#publish-by-hand) applies. [Re-run the merge commit's run](#re-run-the-merge-commits-run) deletes the release you created and runs the same release-please again.

Keep the order of the steps. Once the label moves, the next push run looks for the release of the version in `.release-please-manifest.json`, by its GitHub release or else by its tag. With neither there, it counts every commit as unreleased and opens a release PR past `$VERSION` with the whole history as its notes. [A bad release](#a-bad-release) does not apply either, because it relies on the tag that release-please never created.

1. Check that no release run is waiting or running. The loop must print nothing:

   ```bash
   for state in requested queued pending waiting in_progress; do gh run list --workflow release.yml --status "$state" --json databaseId --jq '.[].databaseId'; done
   ```

   If it prints run IDs, wait until those runs finish, and run it again.

2. Find the merge commit, and check that it carries the version. The second command must print `$VERSION`:

   ```bash
   SHA=$(gh pr view "$PR" --json mergeCommit --jq .mergeCommit.oid)
   gh api "repos/tibia-sh/tibiawiki-mcp/contents/package.json?ref=$SHA" --jq '.content | @base64d | fromjson | .version'
   ```

3. Write the notes release-please gives the release. They are the PR body between its first and last `---` lines. Read `notes-$VERSION.md`, and check that it holds the whole changelog entry the PR shows:

   ```bash
   gh pr view "$PR" --json body --jq '.body | gsub("\r\n"; "\n") | split("\n") | index("---") as $first | rindex("---") as $last | .[$first + 1:$last] | join("\n") | sub("^\\s+"; "") | sub("\\s+$"; "")' > "notes-$VERSION.md"
   ```

4. Create the release at that commit, with the title release-please gives it. The last command must print `$SHA` and `refs/tags/v$VERSION`:

   ```bash
   gh release create "v$VERSION" --target "$SHA" --title "v$VERSION" --notes-file "notes-$VERSION.md"
   git ls-remote --tags https://github.com/tibia-sh/tibiawiki-mcp.git "v$VERSION"
   ```

5. Move the label. The second command must print `autorelease: tagged` and nothing else:

   ```bash
   gh pr edit "$PR" --remove-label "autorelease: pending" --add-label "autorelease: tagged"
   gh pr view "$PR" --json labels --jq '.labels[].name'
   ```

6. Follow [A release npm does not have](#a-release-npm-does-not-have) through its checks, then [Publish by hand](#publish-by-hand).

When the log shows `Pull request should have been merged`, you can upgrade release-please-action instead of steps 1 to 5. Upgrade only to a release whose release-please no longer reads `merge_commit_sha`. Check that in its source before you rely on it. On 2026-09-13 the newest release-please, 17.11.2, still reads it. The upgrade's push run creates the release at the merge commit and moves the label. It fails at `Release tagged at another commit, not published`, because the upgrade's commit triggered it. From there, follow [A release npm does not have](#a-release-npm-does-not-have) with [Publish by hand](#publish-by-hand), because re-running the merge commit's run runs the old release-please.

## A release npm does not have

The tag and the GitHub release exist, and `npm view @tibia.sh/tibiawiki-mcp versions --json` does not list the version.

| How it happened | What you see |
|---|---|
| The run for the merge commit failed or was cancelled after release-please created the release. npm was down, the trusted publisher did not match, or a test failed on the runner. | That run is red at the step that failed. A trusted publisher that does not match fails `npm publish` with `ENEEDAUTH`. |
| A run triggered at another commit reached the merged release PR first. Release runs wait their turn, and GitHub does not guarantee their order. The merge queue closes the stale-release-PR case: a release PR merges only when it was built on the latest `main`, after the `release` run for that commit succeeded, and after `test` passed on top of it. | That run is red at `Release tagged at another commit, not published`, and its error names the tag and both commits. The merge commit's own run is green and published nothing. |
| Someone re-ran one of those runs. | The latest attempt is green, and the red one is behind the **Latest** menu. |

This is urgent. The release commit pinned `.mcp.json` to the new version, so the plugin on `main` cannot start until npm has it. Once [the re-run](#re-run-the-merge-commits-run) deletes the release tag, installs and updates of the plugin from the marketplace fail until release-please creates it again. While you follow either recovery below, merge nothing to `main`.

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

   Then [check for a stray release PR](#a-stray-release-pr).

4. Label the PR pending again. The second command must print `autorelease: pending` and nothing else:

   ```bash
   gh pr edit "$PR" --remove-label "autorelease: tagged" --add-label "autorelease: pending"
   gh pr view "$PR" --json labels --jq '.labels[].name'
   ```

5. [Check for a stray release PR](#a-stray-release-pr) again. Then re-run all jobs of the merge commit's run, never the red run of another commit. Follow it on the run page or with `gh run watch "$RUN"`.

   ```bash
   gh run rerun "$RUN"
   ```

6. Check the result. The run is green with its `npm publish` and `Publish to the MCP registry` steps run, `gh release view "v$VERSION" --json targetCommitish` names `$SHA`, and the PR is back to `autorelease: tagged`. Once npm lists the version, run `pnpm smoke "@tibia.sh/tibiawiki-mcp@$VERSION"` in an installed checkout.

Any other release run that starts between steps 3 and 5 undoes this. After step 4 it creates the release itself, in a run triggered at the wrong commit, and you are back at the start. Before step 4 it opens or rewrites the release PR for a version past `$VERSION`, with the whole history as its notes.

#### A stray release PR

Any release PR opened or updated between steps 3 and 5 merges itself. The run that opens or updates it turns on its auto-merge, it is added to the merge queue as soon as its CI passes, and the queue merges it once `test` passes on top of `main`, all within minutes. A stray PR that shows a version past `$VERSION` then publishes that wrong version, and npm never lets a version be taken back. So check for one right after step 3, and again before the re-run in step 5. Its auto-merge tells you nothing: a PR in the queue shows `autoMergeRequest` as `null` while it is about to merge. So take every open release PR out of the queue and close it. List them:

```bash
gh pr list --label "autorelease: pending" --json number,id,title
```

For each PR it lists, put its `id` in place of `ID` and its number in place of `N`, take it out of the queue, and close it:

```bash
gh api graphql -f query='mutation($id:ID!){dequeuePullRequest(input:{id:$id}){clientMutationId}}' -f id=ID
gh pr close N
```

A PR that is not in the queue makes `gh api` exit 1 with GitHub's error and changes nothing, so go on and close it. While `main` has no queue, the error is `No merge queue found for branch 'main'`. List them again, and go on only when the list prints `[]`.

Do not add `autorelease: snooze` to a PR you closed, because release-please reopens and reuses a closed PR with that label. Closing loses nothing, since the next release run opens a fresh release PR when there is something to release.

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

   The list must hold only `dist/`, `data/spell-areas.json`, `data/tibiawikisql-requirements.txt`, `package.json`, `README.md` and `LICENSE`.

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

**Exercised twice.** The `0.3.0` dispatch, run [34756032998](https://github.com/tibia-sh/tibiawiki-mcp/actions/runs/34756032998), and the `0.3.1` dispatch, run [34770387551](https://github.com/tibia-sh/tibiawiki-mcp/actions/runs/34770387551), used it before the `registry` job retried its publish. It follows the source of the registry and `mcp-publisher` at `v1.8.1`, the version `release.yml` pins.

npm lists the version, and the MCP registry does not. Set `VERSION` and check both:

```bash
VERSION=X.Y.Z
npm view @tibia.sh/tibiawiki-mcp versions --json
curl -sS "https://registry.modelcontextprotocol.io/v0.1/servers/sh.tibia%2Ftibiawiki-mcp/versions/$VERSION"
```

The registry lacks the version when `curl` prints `"detail":"Server not found"`. When it has the version, `curl` prints its entry, with `"version":"X.Y.Z"` under `server`. For a version npm does not list, start at [A release npm does not have](#a-release-npm-does-not-have).

The registry reads the version from npm once and does not retry, so the `registry` job waits for npm to serve a new version before it logs in. A version npm is slow to serve still lands here when that wait runs out, or when the registry's own read of npm misses a version the wait saw in all three attempts.

| How it happened | What you see |
|---|---|
| The key is missing from the `mcp-registry` environment, or the TXT record on `tibia.sh` is missing or holds another key. | The release run is red at `Publish to the MCP registry` after three attempts, with `private key (hex) is required`, `no MCP public key found in DNS TXT records` or `signature verification failed`. When the key is set, each login prints the TXT record it expects. |
| npm did not serve the version with `mcpName` `sh.tibia/tibiawiki-mcp` in 40 tries, 15 seconds apart. | The release run is red at `Wait for npm to serve the tag's version`, and its error names the version. |
| The registry failed or was down, or its own read of npm failed. | The release run is red at `Publish to the MCP registry` after three attempts, the last with the registry's error, such as `Likely transient, retry later` for a failed read of npm. |
| The registry was unreachable, or a login or publish failed on the network. | The release run is red at `Publish to the MCP registry` after three failed attempts, the last with an error such as `dial tcp ... i/o timeout`. The log says what failed in each attempt, and exit code 124 or 137 means `timeout` stopped a login or publish after 120 seconds. |
| The version reached npm through [Publish by hand](#publish-by-hand). | No `registry` job ran for the version. |

Dispatch the release workflow on `main` with the version's tag. It waits its turn behind any release run in progress.

```bash
gh workflow run release.yml --ref main -f tag="v$VERSION"
```

`gh` prints the URL of the run it started. Follow the run there, or with `gh run watch <run-id>`, where the run ID is the number at the end of the URL. If `gh` prints no URL, `gh run list --workflow release.yml --event workflow_dispatch` lists dispatched runs, newest first. Yours is the one created when you dispatched.

A dispatched run's `please` job skips every step, release-please included, so it releases nothing, and its `release` job publishes nothing to npm. Only its `registry` job acts. It checks out the tag, checks that `server.json` carries the version, waits until npm serves that version, and publishes it. A version npm already serves passes the wait on the first try.

Dispatch on `main` only. The `please` job runs in the `release-trigger` environment, and the `registry` job in the `mcp-registry` environment, which holds the key. Both admit runs on `main` alone. A run dispatched on any other branch or tag fails at the `please` job before its first step, and skips the jobs after it. The tag reaches the `registry` job as the input, never as the ref.

If the registry has the version already, the dispatched run ends green without publishing. `Publish to the MCP registry` finds the version before it logs in, or the registry rejects the publish with `cannot publish duplicate version`. The registry never takes a version twice. Registering an older version after a newer one is fine. The registry keeps the higher version as its latest.

The recovery is done when the run is green and the `curl` above prints the version.

If `Check that server.json carries the tag's version` fails, or the registry rejects the tag's `server.json`, the workflow cannot register that version. Leave it out of the registry, and fix `server.json` in the next release.

The same goes for a version npm serves with another `mcpName`, or none, because `Wait for npm to serve the tag's version` never passes for it. Before you dispatch again after that step failed, check what npm serves. This must print `sh.tibia/tibiawiki-mcp`:

```bash
curl -sS "https://registry.npmjs.org/@tibia.sh%2Ftibiawiki-mcp/$VERSION" | jq -r .mcpName
```

If it prints anything else, or `null`, leave the version out of the registry, and fix `mcpName` in `package.json` in the next release.

## The hosting dispatch

Once npm accepts the publish, the run's `hosting` job tells `tibia-sh/mcp.tibia.sh` about the release. Its step `Tell mcp.tibia.sh about the release` sends a `repository_dispatch` of type `first-party-release` that names the package and the version. It sends it as the tibia-sh App: the job runs in the `release-trigger` environment, and its first step mints a token for `tibia-sh/mcp.tibia.sh` alone, with contents write, which expires within the hour. The dispatch makes up to three attempts, 30 seconds apart, and prints `Told tibia-sh/mcp.tibia.sh about @tibia.sh/tibiawiki-mcp X.Y.Z in attempt N.` once one got through. The job needs only the release job, so it runs beside the `registry` job, and neither waits for the other. A dispatched run of `release.yml` releases nothing, so it skips the job.

The dispatch starts `bump.yml` in the hosting repo. That run pins the version, opens a pull request, turns on auto-merge, which merges at once when the checks have already passed, and waits for the merge, and the merge deploys. [How a release reaches the endpoint](https://github.com/tibia-sh/mcp.tibia.sh/blob/main/docs/OPERATING.md#how-a-release-reaches-the-endpoint) in that repository's `docs/OPERATING.md` describes the chain and what can go wrong there. `gh run list --workflow bump.yml -R tibia-sh/mcp.tibia.sh` lists its runs.

A red `hosting` job leaves npm and the MCP registry untouched. The publish happened before the job started, and the `registry` job does not wait for the dispatch. The job is red when the App's token could not be minted, when the tag does not look like `vX.Y.Z`, or when all three attempts failed. Its error line names the tag or the version, and the log carries what `gh` said about each attempt. Three attempts that all hang take 7.5 minutes, inside the job's 8, so the job normally ends with that error line. A red token step, or `Bad credentials (HTTP 401)` from `gh`, means the App's key or its installation no longer works, and [The tibia-sh App](https://github.com/tibia-sh/mcp.tibia.sh/blob/main/docs/OPERATING.md#the-tibia-sh-app) in the hosting repo's `docs/OPERATING.md` describes how to rotate the key.

Never re-run the release run for it. A re-run of all jobs does not send the dispatch again: its `please` job releases nothing the second time, so `released` stays empty and the `hosting` job is skipped. A re-run of failed jobs would run the `hosting` job again with the `release` job's outputs from the failed attempt, as [Re-running a release run](#re-running-a-release-run) describes. Run `bump.yml` by hand instead, on `main` of the hosting repo, with the version npm has:

```bash
gh workflow run bump.yml -R tibia-sh/mcp.tibia.sh --ref main -f package=@tibia.sh/tibiawiki-mcp -f version=X.Y.Z
```

The run it starts does what the dispatch would have. A version the hosting repo already pins ends it green with nothing to do, so a dispatch that arrived after all costs nothing. A version below the pinned one fails it, because `bump.yml` refuses a downgrade.

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
2. Let the release PR be added to the merge queue, as in [A normal release](#a-normal-release).
3. If npm does not have the bad version, retitle its GitHub release, so nobody takes it for a published one:

   ```bash
   gh release edit "v$VERSION" --title "v$VERSION, not on npm"
   ```

Until the patch is on npm, `.mcp.json` on `main` pins the bad version. When npm does not have that version, the plugin on `main` cannot start.

## Setting up the MCP registry publish

**Done 2026-09-13.** `v0.3.0` was registered that day through [A version the MCP registry does not have](#a-version-the-mcp-registry-does-not-have). If the key or the TXT record goes away, the `registry` job fails at `Publish to the MCP registry` after three attempts, and every release lands in that section again.

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

6. Install `mcp-publisher` 1.8.1, the version `release.yml` pins, in the same directory. This is the build for a Mac with Apple silicon. The sha256 is the one `registry_1.8.1_checksums.txt` lists for it, and `tar` unpacks nothing unless the archive matches it.

   ```bash
   curl -fsSL -o mcp-publisher_darwin_arm64.tar.gz https://github.com/modelcontextprotocol/registry/releases/download/v1.8.1/mcp-publisher_darwin_arm64.tar.gz
   echo "e45e520892460732a4bdf37255576415d4a53ec171f8b913faf15bb1aef7cb77  mcp-publisher_darwin_arm64.tar.gz" | shasum -a 256 -c - && tar -xzf mcp-publisher_darwin_arm64.tar.gz mcp-publisher
   ```

7. Check the private key, then store it as the secret, in the form `mcp-publisher` takes: the hex of the key's 32-byte seed. The login checks the key against the TXT record, as the `registry` job does, and must print `✓ Successfully logged in`. Only then does `gh` store the key, and it confirms with `Set Actions secret MCP_PRIVATE_KEY`. The login and `gh` run only when the hex is 64 characters long. The key reaches both commands from a variable, so it is never shown, pasted or written to your shell history. `mcp-publisher` 1.8.1 takes it only as an argument, so any process on your Mac can read it while the login runs.

   ```bash
   PRIVATE_KEY="$("$OPENSSL" pkey -in key.pem -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n')"
   [ "${#PRIVATE_KEY}" -eq 64 ] && ./mcp-publisher login dns --domain tibia.sh --private-key "$PRIVATE_KEY" && printf '%s' "$PRIVATE_KEY" | gh secret set MCP_PRIVATE_KEY --env mcp-registry --repo tibia-sh/tibiawiki-mcp
   unset PRIVATE_KEY
   ./mcp-publisher logout
   ```

   The login saves a registry token to `~/.config/mcp-publisher/token.json`, and `mcp-publisher logout` deletes it. If the login fails with `signature verification failed`, compare the TXT record it prints with the output of step 5. Then run the commands again.

8. Delete `key.pem`, or keep it where only you can read it, such as a password manager. GitHub never shows the secret again. Without `key.pem`, replacing the secret means a new key, and a new TXT record in place of the old one.

9. Publish the current release to the registry, as in [A version the MCP registry does not have](#a-version-the-mcp-registry-does-not-have). If `Publish to the MCP registry` fails with `signature verification failed`, compare the TXT record its login prints with the output of step 5. The run tests the key only when its log shows `✓ Successfully logged in`. When the registry already has the current release, the step finds it and ends green without a login, so the next release is the first run to log in with the key. Once the run is green, record the date at the top of this section.

## Known future break

GitHub's REST API version `2026-03-10` drops `merge_commit_sha` from pull request responses, per [`data/reusables/rest-api/breaking-changes-changelog.md`](https://github.com/github/docs/blob/main/data/reusables/rest-api/breaking-changes-changelog.md) in github/docs. release-please 17.6.0 finds the release commit through that field, so without it a merged release PR creates no release. Its step still ends green. `Check that every merged release PR was released` then turns that run red, and every push run after it, until the PR is released. release-please sends no API version header, so it gets `2022-11-28`, which GitHub serves to such requests until 24 months after `2026-03-10`, around March 2028. Upgrade release-please-action to a release that handles this before then. The break is reported upstream as [googleapis/release-please#2898](https://github.com/googleapis/release-please/issues/2898). If the check turns red first, follow [A merged release PR with no release](#a-merged-release-pr-with-no-release). Every release PR stalls the same way until the upgrade.
