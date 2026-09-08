"""Read only external runtime settings from the main checkout; never execute dotenv."""
import os
from pathlib import Path
import shlex
import subprocess

MODEL_KEYS = {
    'google': ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    'anthropic': ['ANTHROPIC_API_KEY'], 'openai': ['OPENAI_API_KEY'],
    'openrouter': ['OPENROUTER_API_KEY'], 'zai': ['ZAI_API_KEY'],
    'zai-coding-cn': ['ZAI_CODING_CN_API_KEY'],
}
RUNTIME_KEYS = frozenset(['MODEL_PROVIDER', 'MODEL_ID', 'BOX_API_KEY', 'BOX_TEMPLATE', 'LOCAL_RUNTIME',
                          *[key for keys in MODEL_KEYS.values() for key in keys]])


def primary_checkout(root):
    result = subprocess.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
                            cwd=root, capture_output=True, text=True, timeout=5)
    if result.returncode:
        return root
    return Path(result.stdout.strip()).parent


def read_runtime_file(path):
    if not path.is_file():
        return {}
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip().removeprefix('export ')
        key, separator, value = line.partition('=')
        key = key.strip()
        if not separator or key not in RUNTIME_KEYS:
            continue
        try:
            words = shlex.split(value, comments=True)
        except ValueError:
            raise RuntimeError(f'Invalid runtime setting {key} in {path.name}') from None
        values[key] = ' '.join(words)
    return values


def runtime_environment(root, environ=None):
    """Main .env < worktree .env < shell. Return only the selected provider key."""
    values = read_runtime_file(primary_checkout(root) / '.env')
    values.update(read_runtime_file(root / '.env'))
    values.update({key: value for key, value in (os.environ if environ is None else environ).items()
                   if key in RUNTIME_KEYS})
    provider = values.get('MODEL_PROVIDER', 'google')
    allowed = ['MODEL_PROVIDER', 'MODEL_ID', 'BOX_API_KEY', 'BOX_TEMPLATE', 'LOCAL_RUNTIME', *MODEL_KEYS.get(provider, [])]
    return {key: values[key] for key in allowed if values.get(key)}
