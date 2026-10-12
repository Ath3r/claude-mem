#!/usr/bin/env python3
"""Prepare upstream merges without touching the caller's checkout or deploying."""
import argparse
import os
import pathlib
import subprocess
import tempfile


def run(*args, cwd, check=True, env=None):
    return subprocess.run(args, cwd=cwd, check=check, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)


def git(repo, *args, check=True):
    location_keys = {"GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
                     "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                     "GIT_NAMESPACE", "GIT_PREFIX"}
    env = {key: value for key, value in os.environ.items() if key not in location_keys}
    return run("git", "-c", "core.hooksPath=/dev/null", *args,
               cwd=repo, check=check, env=env)


def prepare(repo, upstream="upstream", origin="origin", base="main", check_only=False,
            publish=False, github_repo=None):
    repo = pathlib.Path(repo).resolve()
    for value in (upstream, origin, base):
        if value.startswith("-"):
            raise ValueError("Remote and branch names must not begin with '-'.")
    if publish and not github_repo:
        raise ValueError("--publish requires an explicit --github-repo owner/name")
    # Fetch only the required branches. Never reset, rebase, or pull the live tree.
    for remote in (origin, upstream):
        git(repo, "fetch", "--no-tags", remote,
            f"+refs/heads/{base}:refs/remotes/{remote}/{base}")
    base_sha = git(repo, "rev-parse", f"refs/remotes/{origin}/{base}").stdout.strip()
    upstream_sha = git(repo, "rev-parse", f"refs/remotes/{upstream}/{base}").stdout.strip()
    if git(repo, "merge-base", "--is-ancestor", upstream_sha, base_sha, check=False).returncode == 0:
        return {"status": "current", "upstream": upstream_sha}
    branch = f"upstream-sync/{upstream_sha[:12]}-onto-{base_sha[:12]}"
    if check_only:
        return {"status": "update-available", "branch": branch, "upstream": upstream_sha}
    if not publish and git(repo, "show-ref", "--verify", "--quiet",
                           f"refs/heads/{branch}", check=False).returncode == 0:
        return {"status": "already-prepared", "branch": branch}
    existing = git(repo, "ls-remote", "--heads", origin, f"refs/heads/{branch}").stdout.strip()
    if existing:
        if publish:
            ensure_pr(repo, github_repo, branch, base, upstream_sha)
        return {"status": "already-published", "branch": branch}
    with tempfile.TemporaryDirectory(prefix="claude-mem-upstream-") as directory:
        tree = pathlib.Path(directory) / "candidate"
        git(repo, "worktree", "add", "--detach", str(tree), base_sha)
        try:
            message = (f"Keep fork features compatible with upstream {upstream_sha[:12]}\n\n"
                       "Constraint: Preserve fork commits through an ordinary merge\n"
                       "Confidence: low\nScope-risk: broad\n"
                       "Not-tested: Candidate requires compatibility validation before release")
            merged = git(tree, "-c", "user.name=Fork Updater", "-c",
                         "user.email=fork-updater@users.noreply.github.com", "-c",
                         "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
                         "merge", "--no-ff", "--no-edit", "-m", message,
                         upstream_sha, check=False)
            if merged.returncode:
                conflicts = git(tree, "diff", "--name-only", "--diff-filter=U").stdout.strip()
                raise RuntimeError("Upstream merge stopped; main was not changed.\n" +
                                   (conflicts or merged.stderr or merged.stdout))
            candidate = git(tree, "rev-parse", "HEAD").stdout.strip()
            if publish:
                # Empty expected value means this branch must not already exist.
                git(tree, "push", f"--force-with-lease=refs/heads/{branch}:",
                    origin, f"{candidate}:refs/heads/{branch}")
                ensure_pr(repo, github_repo, branch, base, upstream_sha)
            else:
                # Atomic create only; do not replace any existing local branch.
                git(repo, "update-ref", f"refs/heads/{branch}", candidate, "0" * 40)
            return {"status": "draft-pr" if publish else "prepared", "branch": branch,
                    "commit": candidate, "upstream": upstream_sha}
        finally:
            git(repo, "worktree", "remove", "--force", str(tree))


def ensure_pr(repo, github_repo, branch, base, upstream_sha):
    existing = run("gh", "pr", "list", "--repo", github_repo, "--head", branch,
                   "--base", base, "--state", "open", "--json", "url", cwd=repo).stdout
    import json
    if json.loads(existing):
        return
    body = (f"Merge upstream `{upstream_sha}` while retaining the fork's commits.\n\n"
            "This is an automatically prepared **draft**, not a validated release.\n\n"
            "Before merge: review upstream changes; run version consistency, typecheck, "
            "build, relevant upstream tests, and multi-device sync regression tests. "
            "Test with disposable databases, never the live memory store.\n\n"
            "PR workflows created through GITHUB_TOKEN may require approval to run. "
            "Approve and verify validation before marking ready. No deployment is performed.")
    with tempfile.TemporaryDirectory(prefix="claude-mem-pr-") as directory:
        path = pathlib.Path(directory) / "body.md"
        path.write_text(body)
        result = run("gh", "pr", "create", "--repo", github_repo, "--base", base,
                     "--head", branch, "--draft", "--title",
                     f"Integrate upstream {upstream_sha[:12]} without losing fork features",
                     "--body-file", str(path), cwd=repo)
        print(result.stdout.strip())


if __name__ == "__main__":
    import json
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=str(pathlib.Path(__file__).resolve().parents[2]))
    parser.add_argument("--upstream", default="upstream")
    parser.add_argument("--origin", default="origin")
    parser.add_argument("--base", default="main")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="Fetch and report only")
    mode.add_argument("--publish", action="store_true", help="Push candidate and create draft PR")
    parser.add_argument("--github-repo", help="Explicit fork owner/name for publishing")
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.repo, args.upstream, args.origin, args.base,
                                 args.check, args.publish, args.github_repo), indent=2))
    except (RuntimeError, ValueError, subprocess.CalledProcessError) as error:
        if isinstance(error, subprocess.CalledProcessError):
            parser.exit(1, error.stderr or "Command failed\n")
        parser.exit(1, str(error) + "\n")
