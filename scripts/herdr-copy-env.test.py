"""Exercise the hook through real Git worktree creation with fake credentials."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class CopyEnvironmentTests(unittest.TestCase):
    def test_git_worktree_creation_copies_private_env_without_overwriting(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'main'; root.mkdir()
            target = Path(directory) / 'worktree'
            env = {**os.environ, 'HERDR_ENV': '1', 'GIT_AUTHOR_NAME': 'Test',
                   'GIT_AUTHOR_EMAIL': 'test@example.com', 'GIT_COMMITTER_NAME': 'Test',
                   'GIT_COMMITTER_EMAIL': 'test@example.com'}
            def git(*args, cwd=root, runtime=env):
                subprocess.run(['git', *args], cwd=cwd, env=runtime, check=True,
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            git('init')
            (root / '.gitignore').write_text('.env\n')
            git('add', '.gitignore'); git('commit', '-m', 'test: initial')
            hook = root / '.git/hooks/post-checkout'
            shutil.copyfile(Path(__file__).with_name('herdr-copy-env.py'), hook); hook.chmod(0o700)
            (root / '.env').write_text('ZAI_API_KEY=fake-test-key\n')
            git('worktree', 'add', '-b', 'test-worktree', str(target))
            self.assertEqual((target / '.env').read_bytes(), (root / '.env').read_bytes())
            self.assertEqual((target / '.env').stat().st_mode & 0o777, 0o600)
            git('check-ignore', '-q', '.env', cwd=target)
            (target / '.env').write_text('local override\n')
            git('checkout', '-b', 'another-branch', cwd=target)
            self.assertEqual((target / '.env').read_text(), 'local override\n')
            outside = Path(directory) / 'outside'
            git('worktree', 'add', '-b', 'outside-herdr', str(outside), runtime={**env, 'HERDR_ENV': '0'})
            self.assertFalse((outside / '.env').exists())


if __name__ == '__main__':
    unittest.main()
