#!/usr/bin/env python3
"""Disposable local Git integration checks for the fork updater."""
import importlib.util
import os
import pathlib
import shlex
import subprocess
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('sync_upstream', pathlib.Path(__file__).with_name('sync-upstream.py'))
updater = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(updater)


class UpstreamSyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='test-fork-upstream-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.seed = self.root / 'seed'
        self.seed.mkdir()
        self.command(self.seed, 'init', '-b', 'main')
        self.command(self.seed, 'config', 'user.name', 'Fixture')
        self.command(self.seed, 'config', 'user.email', 'fixture@example.invalid')
        self.commit(self.seed, 'shared.txt', 'baseline\n', 'Baseline')
        self.origin = self.root / 'origin.git'
        self.upstream = self.root / 'upstream.git'
        self.command(self.root, 'clone', '--bare', str(self.seed), str(self.origin))
        self.command(self.root, 'clone', '--bare', str(self.seed), str(self.upstream))
        self.repo = self.root / 'caller'
        self.command(self.root, 'clone', str(self.origin), str(self.repo))
        self.command(self.repo, 'config', 'user.name', 'Fixture')
        self.command(self.repo, 'config', 'user.email', 'fixture@example.invalid')
        self.command(self.repo, 'remote', 'add', 'upstream', str(self.upstream))
        self.fork_sha = self.commit(self.repo, 'fork.txt', 'custom feature\n', 'Keep custom feature')
        self.command(self.repo, 'push', 'origin', 'main')
        self.command(self.seed, 'remote', 'add', 'upstream', str(self.upstream))

    def command(self, cwd, *args):
        return subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', *args],
                              cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()

    def commit(self, repo, filename, content, message):
        (repo / filename).write_text(content)
        self.command(repo, 'add', filename)
        self.command(repo, 'commit', '-m', message)
        return self.command(repo, 'rev-parse', 'HEAD')

    def advance_upstream(self, filename='upstream.txt', content='upstream improvement\n'):
        sha = self.commit(self.seed, filename, content, 'Upstream improvement')
        self.command(self.seed, 'push', 'upstream', 'main')
        return sha

    def branches(self):
        return self.command(self.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads')

    def worktrees(self):
        return self.command(self.repo, 'worktree', 'list', '--porcelain')

    def test_ordinary_merge_retains_custom_commit_and_leaves_main_unchanged(self):
        upstream_sha = self.advance_upstream()
        main_before = self.command(self.repo, 'rev-parse', 'main')
        trees_before = self.worktrees()
        result = updater.prepare(self.repo)
        self.assertEqual(result['status'], 'prepared')
        self.assertEqual(self.command(self.repo, 'rev-parse', 'main'), main_before)
        self.assertEqual(self.command(self.repo, 'show', result['commit'] + ':fork.txt'), 'custom feature')
        self.assertEqual(self.command(self.repo, 'show', result['commit'] + ':upstream.txt'), 'upstream improvement')
        parents = self.command(self.repo, 'rev-list', '--parents', '-n', '1', result['commit']).split()
        self.assertEqual(parents[1:], [self.fork_sha, upstream_sha])
        self.assertEqual(self.worktrees(), trees_before)

    def test_conflict_stops_without_main_or_branch_mutation_and_cleans_worktree(self):
        main_before = self.commit(self.repo, 'shared.txt', 'fork side\n', 'Fork edit')
        self.command(self.repo, 'push', 'origin', 'main')
        self.advance_upstream('shared.txt', 'upstream side\n')
        branches_before, trees_before = self.branches(), self.worktrees()
        with self.assertRaisesRegex(RuntimeError, 'shared.txt'):
            updater.prepare(self.repo)
        self.assertEqual(self.command(self.repo, 'rev-parse', 'main'), main_before)
        self.assertEqual(self.branches(), branches_before)
        self.assertEqual(self.worktrees(), trees_before)
        self.assertEqual((self.repo / 'shared.txt').read_text(), 'fork side\n')

    def test_dirty_tracked_staged_and_untracked_files_remain_untouched(self):
        self.advance_upstream()
        (self.repo / 'fork.txt').write_text('staged local work\n')
        self.command(self.repo, 'add', 'fork.txt')
        (self.repo / 'fork.txt').write_text('unstaged local work\n')
        (self.repo / 'untracked.txt').write_text('untracked local work\n')
        before = {name: self.command(self.repo, *args) for name, args in {
            'status': ('status', '--porcelain'), 'diff': ('diff',),
            'staged': ('diff', '--cached'), 'head': ('rev-parse', 'HEAD')}.items()}
        updater.prepare(self.repo)
        after = {name: self.command(self.repo, *args) for name, args in {
            'status': ('status', '--porcelain'), 'diff': ('diff',),
            'staged': ('diff', '--cached'), 'head': ('rev-parse', 'HEAD')}.items()}
        self.assertEqual(after, before)
        self.assertEqual((self.repo / 'untracked.txt').read_text(), 'untracked local work\n')

    def test_check_only_reports_without_candidate_branch_or_worktree(self):
        self.advance_upstream()
        before = self.branches(), self.worktrees()
        result = updater.prepare(self.repo, check_only=True)
        self.assertEqual(result['status'], 'update-available')
        self.assertEqual((self.branches(), self.worktrees()), before)

    def test_current_is_noop(self):
        before = self.branches(), self.worktrees()
        result = updater.prepare(self.repo)
        self.assertEqual(result['status'], 'current')
        self.assertEqual((self.branches(), self.worktrees()), before)

    def test_repeated_local_prepare_reuses_candidate(self):
        self.advance_upstream()
        first = updater.prepare(self.repo)
        candidate_before = self.command(self.repo, 'rev-parse', first['branch'])
        trees_before = self.worktrees()
        second = updater.prepare(self.repo)
        self.assertEqual(second['branch'], first['branch'])
        self.assertEqual(self.command(self.repo, 'rev-parse', first['branch']), candidate_before)
        self.assertEqual(self.worktrees(), trees_before)

    def test_failed_pr_creation_can_retry_published_branch(self):
        self.advance_upstream()
        with mock.patch.object(updater, 'ensure_pr', side_effect=RuntimeError('mock PR failure')):
            with self.assertRaisesRegex(RuntimeError, 'mock PR failure'):
                updater.prepare(self.repo, publish=True, github_repo='fixture/fork')
        trees_before = self.worktrees()
        with mock.patch.object(updater, 'ensure_pr') as ensure:
            result = updater.prepare(self.repo, publish=True, github_repo='fixture/fork')
        self.assertEqual(result['status'], 'already-published')
        ensure.assert_called_once()
        self.assertEqual(ensure.call_args.args[1], 'fixture/fork')
        self.assertEqual(self.worktrees(), trees_before)
        self.assertEqual(self.command(self.repo, 'rev-parse', 'main'), self.fork_sha)

    def test_checkout_and_push_hooks_never_run(self):
        self.advance_upstream()
        hooks = self.root / 'hooks'
        hooks.mkdir()
        markers = []
        for name in ('post-checkout', 'pre-push'):
            marker = self.root / (name + '.ran')
            markers.append(marker)
            hook = hooks / name
            hook.write_text('#!/bin/sh\nprintf executed > ' + shlex.quote(str(marker)) + '\n')
            hook.chmod(0o755)
        self.command(self.repo, 'config', 'core.hooksPath', str(hooks))
        with mock.patch.object(updater, 'ensure_pr'):
            result = updater.prepare(self.repo, publish=True, github_repo='fixture/fork')
        self.assertEqual(result['status'], 'draft-pr')
        self.assertTrue(all(not marker.exists() for marker in markers))
        self.assertEqual(self.command(self.repo, 'rev-parse', 'main'), self.fork_sha)

    def test_inherited_git_location_environment_cannot_redirect_operations(self):
        upstream_sha = self.advance_upstream()
        foreign_head = self.command(self.seed, 'rev-parse', 'HEAD')
        foreign_branches = self.command(self.seed, 'for-each-ref', '--format=%(refname)', 'refs/heads')
        foreign_index = (self.seed / '.git' / 'index').read_bytes()
        hostile = {
            'GIT_DIR': str(self.seed / '.git'),
            'GIT_WORK_TREE': str(self.seed),
            'GIT_INDEX_FILE': str(self.seed / '.git' / 'index'),
            'GIT_COMMON_DIR': str(self.seed / '.git'),
        }
        with mock.patch.dict(os.environ, hostile):
            result = updater.prepare(self.repo)
        self.assertEqual(result['status'], 'prepared')
        self.assertEqual(result['upstream'], upstream_sha)
        self.assertEqual(self.command(self.repo, 'show', result['commit'] + ':fork.txt'), 'custom feature')
        self.assertEqual(self.command(self.repo, 'rev-parse', 'main'), self.fork_sha)
        self.assertEqual(self.command(self.seed, 'rev-parse', 'HEAD'), foreign_head)
        self.assertEqual(self.command(self.seed, 'for-each-ref', '--format=%(refname)', 'refs/heads'), foreign_branches)
        self.assertEqual((self.seed / '.git' / 'index').read_bytes(), foreign_index)


if __name__ == '__main__':
    unittest.main()
