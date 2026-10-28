#!/usr/bin/env python3
"""Root-independent entrypoint. Inputs stay on stdin, never command arguments."""
import json
from pathlib import Path
import runpy
import sys

ROOT = Path(__file__).resolve().parents[1]
COMMANDS = {
    'prepare': ('mail_watch.py', 'prepare'),
    'prepare-brief': ('mail_watch.py', 'prepare-brief'),
    'render-brief': ('render_brief.py', None),
    'rank-search': ('rank_search.py', None),
}


def main():
    if sys.version_info < (3, 10):
        print('Python 3.10 or later is required.', file=sys.stderr)
        return 2
    if len(sys.argv) != 2 or sys.argv[1] not in (*COMMANDS, 'check'):
        print('Use check, prepare, prepare-brief, render-brief or rank-search; supply JSON on stdin.', file=sys.stderr)
        return 2
    if sys.argv[1] == 'check':
        try:
            package = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
            required = ['GMAIL_WORKFLOW.md', 'skills/ebay-mail-watch/SKILL.md']
            required += ['companion/' + item[0] for item in COMMANDS.values()]
            if not all((ROOT / name).is_file() for name in required):
                raise ValueError()
            print(json.dumps({'ready': True, 'version': package['version'],
                              'python': '.'.join(map(str, sys.version_info[:3])),
                              'package_root': str(ROOT)}))
            return 0
        except (OSError, ValueError, KeyError):
            print('Companion installation is incomplete.', file=sys.stderr)
            return 2
    filename, command = COMMANDS[sys.argv[1]]
    script = ROOT / 'companion' / filename
    sys.argv = [str(script)] + ([command] if command else [])
    # Only this fixed allowlist is executable. User input never selects a path.
    sys.path.insert(0, str(script.parent))
    runpy.run_path(str(script), run_name='__main__')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
