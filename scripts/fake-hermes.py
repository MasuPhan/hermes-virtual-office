#!/usr/bin/env python3
"""
Read-only fake Hermes CLI for previews and UI tests.

HVO must never create, move, archive or delete a real task while it is being
tested, so a preview runs against this script instead of ~/.local/bin/hermes:

    python3 scripts/fake-hermes.py --init /tmp/fake-root     # writes profiles + SOUL.md
    HERMES_BIN=scripts/fake-hermes.py HVO_HERMES_ROOT=/tmp/fake-root HERMES_HOME=/tmp/fake-root ...

It answers the read verbs HVO uses (boards list, list, show, assignees, runs,
log, attachments, stats, config get, cron runs/list) from the fixture below, which mirrors the
shapes measured on a real Hermes v0.21 install: `created_by` holds the creating
profile's name, links show up as `parents`/`children` in `show`, and unassigned
cards wait in `triage`. Every other verb is refused with exit code 3 and logged
as WRITE_REFUSED in `<this file>.log`, so a test can prove nothing tried to write.

State: when HERMES_HOME is set, `kanban create` is accepted and kept in
`$HERMES_HOME/fake-state.json` (logged as WRITE_FAKE) so the assign flow can be
exercised end to end. A test moves a card with the helper

    scripts/fake-hermes.py --set-status <board> <task id> <status> [summary or reason]

which records the same `completed`/`blocked` event (payload `summary`/`reason`)
the real CLI writes. Nothing here ever reaches a real Hermes install.
"""
import json
import os
import sys
import time

NOW = int(time.time())
H = 3600

# name -> (role, division, domains, model); None role = no SOUL marker (old profile)
PROFILES = {
    'default': ('orchestrator', 'exec', 'planning,delegation', 'claude-opus'),
    'developer': ('backend', 'tech', 'api,database', 'claude-sonnet'),
    'devops': ('devops', 'tech', 'deploy,ci', 'claude-sonnet'),
    'qa-engineer': ('qa', 'tech', 'testing', 'claude-haiku'),
    'writer': ('content', 'content', 'blog,copy', 'claude-sonnet'),
    'growth-marketer': ('marketing', 'growth', 'seo,ads', 'claude-sonnet'),
    'idle-agent': (None, None, '', None),
}

BOARDS = [
    {'slug': 'default', 'name': 'Default', 'is_current': True},
    {'slug': 'marketing', 'name': 'Marketing'},
    {'slug': 'empty-board', 'name': 'Empty board'},
]


def task(tid, title, assignee, status, created_by, age_h, parents=(), archived=False, done_h=None):
    return {
        'id': tid, 'title': title, 'assignee': assignee, 'status': 'archived' if archived else status,
        'created_by': created_by, 'priority': 0, 'body': 'Fixture task (fake Hermes).',
        'created_at': NOW - int(age_h * H), 'started_at': NOW - int(age_h * H) + 60,
        'completed_at': NOW - int(done_h * H) if done_h is not None else None,
        '_parents': list(parents),
    }


TASKS = {
    'default': [
        task('t_root01', 'Ra mắt tính năng thanh toán', 'default', 'todo', 'user', 30, parents=('t_dev01', 't_qa01')),
        task('t_dev01', 'Viết API thanh toán', 'developer', 'running', 'default', 20),
        task('t_qa01', 'Kiểm thử luồng thanh toán', 'qa-engineer', 'todo', 'default', 20, parents=('t_dev01',)),
        task('t_ops01', 'Dựng pipeline deploy', 'devops', 'blocked', 'default', 26),
        task('t_ops02', 'Cập nhật chứng chỉ SSL', 'devops', 'done', 'devops', 50, done_h=40),
        task('t_dev02', 'Sửa lỗi đăng nhập', 'developer', 'done', 'user', 72, done_h=60),
        task('t_tri01', 'Ý tưởng: bảng giá mới', None, 'triage', 'user', 5),
        task('t_tri02', 'Ý tưởng: chương trình giới thiệu', None, 'triage', 'dashboard', 4),
        task('t_old01', 'Việc của agent đã xoá', 'old-agent', 'blocked', 'default', 200),
        task('t_arc01', 'Việc cũ đã lưu trữ', 'developer', 'done', 'default', 300, archived=True, done_h=290),
    ],
    'marketing': [
        task('t_mk01', 'Bài blog ra mắt thanh toán', 'writer', 'review', 'growth-marketer', 10),
        task('t_mk02', 'Kế hoạch SEO quý 4', 'growth-marketer', 'ready', 'default', 8),
        task('t_mk03', 'Viết email giới thiệu', 'writer', 'done', 'growth-marketer', 40, done_h=30),
    ],
    'empty-board': [],
}


def state_path():
    home = os.environ.get('HERMES_HOME') or os.environ.get('HVO_HERMES_ROOT')
    return os.path.join(home, 'fake-state.json') if home else None


def load_state():
    p = state_path()
    if not p or not os.path.exists(p):
        return {'created': {}, 'status': {}, 'events': {}}
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def save_state(st):
    p = state_path()
    with open(p + '.tmp', 'w', encoding='utf-8') as f:
        json.dump(st, f, ensure_ascii=False)
    os.replace(p + '.tmp', p)


def apply_state():
    """Overlay created cards and moved statuses on the fixture."""
    st = load_state()
    for board, rows in st['created'].items():
        TASKS.setdefault(board, []).extend(rows)
    for key, status in st['status'].items():
        board, tid = key.split(':', 1)
        for t in TASKS.get(board, []):
            if t['id'] == tid:
                t['status'] = status
                if status == 'done':
                    t['completed_at'] = t.get('completed_at') or NOW
    return st


def log(line):
    try:
        with open(__file__ + '.log', 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except OSError:
        pass


def public(t):
    return {k: v for k, v in t.items() if not k.startswith('_')}


def children_of(board, tid):
    return [t['id'] for t in TASKS.get(board, []) if tid in t['_parents']]


def init_root(root):
    os.makedirs(os.path.join(root, 'profiles'), exist_ok=True)
    for name, (role, division, domains, _model) in PROFILES.items():
        home = root if name == 'default' else os.path.join(root, 'profiles', name)
        os.makedirs(home, exist_ok=True)
        with open(os.path.join(home, 'config.yaml'), 'w', encoding='utf-8') as f:
            f.write('# fake hermes profile\n')
        if role:
            marker = f'<!-- office: role={role} division={division} domains={domains} -->'
            with open(os.path.join(home, 'SOUL.md'), 'w', encoding='utf-8') as f:
                f.write(f'{marker}\n\n# {name}\n\nFixture profile.\n')
    print(root)


def out(obj):
    print(json.dumps(obj, ensure_ascii=False))


def kanban(args):
    board = next((b['slug'] for b in BOARDS if b.get('is_current')), 'default')
    if args[:1] == ['--board']:
        board, args = args[1], args[2:]
    verb = args[0] if args else ''
    rows = TASKS.get(board)
    if rows is None and verb not in ('boards',):
        print(f'unknown board {board}', file=sys.stderr)
        return 1
    if verb == 'boards' and args[1:2] in (['list'], ['ls']):
        res = []
        for b in BOARDS:
            live = [t for t in TASKS[b['slug']] if t['status'] != 'archived']
            counts = {}
            for t in live:
                counts[t['status']] = counts.get(t['status'], 0) + 1
            res.append({**b, 'counts': counts, 'total': len(live)})
        out(res)
    elif verb in ('list', 'ls'):
        archived = '--archived' in args
        out([public(t) for t in rows if archived or t['status'] != 'archived'])
    elif verb == 'show':
        t = next((x for x in rows if x['id'] == args[1]), None)
        if not t:
            print(f'task {args[1]} not found', file=sys.stderr)
            return 1
        events = [{'kind': 'created', 'created_at': t['created_at'], 'run_id': None,
                   'payload': {'assignee': t['assignee'], 'parents': t['_parents']}}]
        events += STATE['events'].get(f"{board}:{t['id']}", [])
        summary = next((e['payload'].get('summary') for e in reversed(events) if e['kind'] == 'completed'), None)
        out({'task': public(t), 'parents': t['_parents'], 'children': children_of(board, t['id']),
             'comments': [], 'events': events, 'runs': [], 'latest_summary': summary})
    elif verb == 'assignees':
        names = sorted(set(PROFILES) | {t['assignee'] for t in rows if t['assignee']})
        res = []
        for n in names:
            counts = {}
            for t in rows:
                if t['assignee'] == n and t['status'] != 'archived':
                    counts[t['status']] = counts.get(t['status'], 0) + 1
            res.append({'name': n, 'on_disk': n in PROFILES, 'counts': counts})
        out(res)
    elif verb in ('runs', 'attachments'):
        out([])
    elif verb in ('log', 'stats'):
        print('')
    elif verb == 'create' and state_path():
        opts = {'--assignee': None, '--body': '', '--created-by': 'user', '--priority': '0'}
        i, title = 1, None
        while i < len(args):
            if args[i] in opts and i + 1 < len(args):
                opts[args[i]] = args[i + 1]
                i += 2
            else:
                title = title if title is not None else args[i]
                i += 1
        tid = 't_%08x' % (int(time.time() * 1000) & 0xffffffff)
        row = task(tid, title or '(no title)', opts['--assignee'], 'ready', opts['--created-by'], 0)
        row['body'] = opts['--body']
        STATE['created'].setdefault(board, []).append(row)
        save_state(STATE)
        log('WRITE_FAKE kanban --board %s create %s' % (board, tid))
        print(f'Created {tid}')
    else:
        log('WRITE_REFUSED kanban ' + ' '.join(args))
        print(f'fake hermes: refusing kanban {verb}', file=sys.stderr)
        return 3
    return 0


def main(argv):
    log(' '.join(argv))
    if argv[:1] == ['--init']:
        init_root(argv[1])
        return 0
    if argv[:1] == ['--set-status']:
        board, tid, status = argv[1], argv[2], argv[3]
        text = argv[4] if len(argv) > 4 else ''
        STATE['status'][f'{board}:{tid}'] = status
        kind = {'done': 'completed', 'blocked': 'blocked'}.get(status, 'status')
        payload = {'summary': text} if kind == 'completed' else {'reason': text} if kind == 'blocked' else {'status': status}
        STATE['events'].setdefault(f'{board}:{tid}', []).append(
            {'kind': kind, 'created_at': int(time.time()), 'run_id': None, 'payload': payload})
        save_state(STATE)
        print(f'{board}:{tid} -> {status}')
        return 0
    if argv[:1] == ['--version']:
        print('Hermes Agent v0.0.0-fake')
        return 0
    profile = None
    if argv[:1] == ['-p']:
        profile, argv = argv[1], argv[2:]
    if argv[:1] == ['kanban']:
        return kanban(argv[1:])
    if argv[:3] == ['config', 'get', 'model']:
        model = PROFILES.get(profile or 'default', (None, None, '', None))[3]
        out({'default': model, 'provider': 'fake'} if model else {})
        return 0
    if argv[:2] == ['config', 'get']:
        out({})
        return 0
    if argv[:2] == ['sessions', 'export']:
        return 0
    if argv[:2] in (['cron', 'runs'], ['cron', 'list']):
        # Read-only: the office polls recent cron runs; the fixture has none.
        return 0
    log('WRITE_REFUSED ' + ' '.join(argv))
    print('fake hermes: unsupported command', file=sys.stderr)
    return 3


STATE = apply_state() if state_path() else {'created': {}, 'status': {}, 'events': {}}

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
