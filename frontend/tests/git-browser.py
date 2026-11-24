"""Git panel browser checks against mocked APIs; backend Git semantics have separate tests."""
import argparse
import json
import re
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--base-url', default='http://127.0.0.1:4174')
parser.add_argument('--browser-executable')
parser.add_argument('--output', default='/tmp/neuronrunner-git-verification')
args = parser.parse_args()
base = args.base_url.rstrip('/')
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)
workspace_id = '10000000-0000-4000-8000-000000000001'
filesystem_id = '20000000-0000-4000-8000-000000000001'
conversation_id = '30000000-0000-4000-8000-000000000001'
user = {'uuid': '40000000-0000-4000-8000-000000000001', 'username': 'git-review', 'email': 'review@example.com'}
workspace = {'uuid': workspace_id, 'name': 'Git workspace', 'slug': 'git-review', 'user_role': 'owner', 'member_count': 1, 'is_personal': True}
filesystem = {'uuid': filesystem_id, 'workspace_uuid': workspace_id, 'filesystem_path': '/workspace', 'display_name': 'Files', 'status': 'running'}
repository = {'path': '/workspace/neuronrunner', 'name': 'neuronrunner', 'github_repository': 'example/neuronrunner', 'remote_url': 'https://github.com/example/neuronrunner'}
status = {**repository, 'branch': 'feature/git-panel', 'branches': [{'name': 'feature/git-panel', 'remote': False}, {'name': 'main', 'remote': False}], 'head_commit': 'a' * 40, 'upstream': 'origin/main', 'ahead': 2, 'behind': 1,
          'files': [{'path': 'src/app.ts', 'previous_path': None, 'status': 'modified', 'staged': True, 'index_status': 'M', 'worktree_status': 'M'}, {'path': 'src/theme.css', 'previous_path': None, 'status': 'untracked', 'staged': False, 'index_status': '?', 'worktree_status': '?'}],
          'history': [{'hash': 'a' * 40, 'subject': 'Improve workspace navigation', 'author': 'Kaan', 'date': '2026-10-14T08:00:00Z'}, {'hash': 'b' * 40, 'subject': 'Add repository browser', 'author': 'Maya', 'date': '2026-10-13T08:00:00Z'}]}
all_history = status['history'] + [{'hash': f'{index:040x}', 'subject': f'Older commit {index}', 'author': 'Test Author', 'date': '2026-10-12T08:00:00Z'} for index in range(2, 45)]
status.update(history=all_history[:20], history_has_next=True, history_next_offset=20, total_commits=len(all_history))
mutations, diffs, errors = [], [], []
history_requests = []
empty, fail_stage = False, False
fail_history = True


def intercept(route):
    global fail_history
    request = route.request
    parsed = urlparse(request.url)
    path = parsed.path.rstrip('/')
    if request.url.startswith(base):
        route.continue_()
        return
    if request.method == 'OPTIONS':
        route.fulfill(status=204, headers={'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*'})
        return
    code, data = 200, []
    if path.endswith('/users/me'):
        data = user
    elif path.endswith('/auth/refresh'):
        data = {'access': 'git-test'}
    elif path.endswith('/sandbox/workspaces'):
        data = [workspace]
    elif path.endswith('/sandbox/sandbox-tools/list'):
        data = {'sandboxes': [], 'workspace_sandbox': filesystem}
    elif path.endswith('/users/balance'):
        data = {'balance': '25.00'}
    elif path.endswith('/conversations/' + conversation_id):
        data = {'conversation': {'uuid': conversation_id, 'title': 'Git review', 'active_request': None, 'messages': [{'uuid': 'answer', 'role': 'assistant', 'content': 'Review your changes in Git.'}]}}
    elif path.endswith('/conversations'):
        data = {'conversations': [{'uuid': conversation_id, 'title': 'Git review', 'is_generating': False}], 'has_next': False}
    elif path.endswith('/git/repositories'):
        data = {'repositories': [] if empty else [repository]}
    elif path.endswith('/git/repository'):
        data = status
    elif path.endswith('/git/history'):
        params = parse_qs(parsed.query)
        offset = int(params['offset'][0])
        assert params['head'][0] == status['head_commit']
        history_requests.append(offset)
        if fail_history:
            fail_history = False
            code, data = 503, {'error': 'History temporarily unavailable.'}
        else:
            has_next = offset + 20 < len(all_history)
            data = {'history': all_history[offset:offset + 20], 'head_commit': params['head'][0], 'has_next': has_next, 'next_offset': offset + 20 if has_next else None, 'total_commits': len(all_history)}
    elif path.endswith('/git/file-diff'):
        mode = parse_qs(parsed.query)['mode'][0]
        diffs.append(mode)
        data = {'diff': '@@ -1 +1 @@\n-before\n+' + mode + ' version\n'}
    elif '/git/' in path and request.method == 'POST':
        operation = path.rsplit('/', 1)[-1]
        payload = request.post_data_json
        mutations.append((operation, payload))
        if operation == 'stage' and fail_stage:
            code, data = 400, {'error': 'Another Git operation holds a repository lock.'}
        else:
            if operation in ('stage', 'unstage'):
                for file in status['files']:
                    if payload.get('all') or file['path'] in payload.get('files', []):
                        file['staged'] = operation == 'stage'
                        file['index_status'] = 'M' if file['staged'] else ' '
                        file['worktree_status'] = ' ' if file['staged'] else 'M'
            elif operation == 'commit':
                assert payload['staged_only'] is True
                status['files'] = [file for file in status['files'] if not file['staged']]
                status['head_commit'] = 'c' * 40
                status['total_commits'] = status.get('total_commits', len(all_history)) + 1
            elif operation == 'switch':
                status['branch'] = payload['branch']
                status['head_commit'] = 'd' * 40
            data = status
    route.fulfill(status=code, content_type='application/json', body=json.dumps(data), headers={'Access-Control-Allow-Origin': '*'})


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, **({'executable_path': args.browser_executable} if args.browser_executable else {}))
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, permissions=['clipboard-read', 'clipboard-write'])
    context.route('**/*', intercept)
    context.add_init_script('''
        localStorage.setItem('token', 'git-test');
        localStorage.setItem('refreshToken', 'git-refresh');
        localStorage.setItem('user', JSON.stringify(%s));
        localStorage.setItem('sidebar-storage', JSON.stringify({state: {isOpen: false}, version: 0}));
        localStorage.setItem('theme', 'dark');
    ''' % json.dumps(user))
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base + '/chat/' + conversation_id)
    page.get_by_role('button', name='Git', exact=True).first.click()
    git = page.get_by_role('region', name='Git repositories', exact=True)
    staged = git.get_by_role('region', name='Staged changes', exact=True)
    unstaged = git.get_by_role('region', name='Unstaged changes', exact=True)
    expect(staged.get_by_text('app.ts', exact=True)).to_be_visible()
    expect(unstaged.get_by_text('app.ts', exact=True)).to_be_visible()
    staged.get_by_role('button', expanded=False).first.click()
    expect(staged.get_by_text('+staged version', exact=True)).to_be_visible()
    unstaged.get_by_role('button', expanded=False).first.click()
    expect(unstaged.get_by_text('+unstaged version', exact=True)).to_be_visible()
    assert {'staged', 'unstaged'} <= set(diffs)
    git.screenshot(path=str(output / 'git-desktop.png'))
    git.get_by_role('button', name='Unstage src/app.ts', exact=True).click()
    expect(git.get_by_role('button', name='Stage all & commit', exact=True)).to_be_visible()
    git.get_by_role('button', name='Stage src/theme.css', exact=True).click()
    expect(git.get_by_role('button', name='Commit 1 staged file', exact=True)).to_be_disabled()
    git.get_by_role('textbox', name='Commit message', exact=True).fill('Refine Git panel')
    expect(git.get_by_role('button', name='Commit 1 staged file', exact=True)).to_be_enabled()
    git.get_by_role('button', name='Commit 1 staged file', exact=True).click()
    expect(git.get_by_text('Committed ccccccc', exact=True)).to_be_visible()
    assert mutations[-1] == ('commit', {'path': repository['path'], 'message': 'Refine Git panel', 'staged_only': True})
    expect(git.get_by_text('theme.css', exact=True)).to_have_count(0)
    fail_stage = True
    git.get_by_role('button', name='Stage src/app.ts', exact=True).click()
    expect(git.get_by_role('alert')).to_contain_text('repository lock')
    expect(git.get_by_role('button', name='Refresh Git', exact=True)).to_be_enabled()
    expect(git.get_by_role('alert')).to_contain_text('repository lock')
    git.get_by_role('button', name='Dismiss error', exact=True).click()
    fail_stage = False
    git.get_by_role('textbox', name='Filter changed files', exact=True).fill('missing')
    expect(git.get_by_text('No files match your search.', exact=True)).to_be_visible()
    git.get_by_role('button', name='Clear search', exact=True).click()
    git.get_by_role('button', name=re.compile('^History')).click()
    commits = git.get_by_role('region', name='Recent commits', exact=True).get_by_role('listitem')
    expect(commits).to_have_count(20)
    assert not history_requests
    scroller = git.locator('div.overflow-y-auto').last
    scroller.evaluate('(element) => element.scrollTop = element.scrollHeight')
    expect(git.get_by_role('alert')).to_contain_text('History temporarily unavailable.')
    expect(commits).to_have_count(20)
    git.get_by_role('button', name='Retry loading commits', exact=True).click()
    expect(commits).to_have_count(40)
    scroller.evaluate('(element) => element.scrollTop = element.scrollHeight')
    expect(commits).to_have_count(45)
    assert history_requests == [20, 20, 40], history_requests
    git.get_by_role('button', name='Refresh Git', exact=True).click()
    expect(git.get_by_role('button', name='Refresh Git', exact=True)).to_be_enabled()
    expect(commits).to_have_count(45)
    assert history_requests == [20, 20, 40]
    git.get_by_role('textbox', name='Search commits', exact=True).fill('Maya')
    expect(git.get_by_text('Add repository browser', exact=True)).to_be_visible()
    expect(git.get_by_text('Improve workspace navigation', exact=True)).to_have_count(0)
    git.get_by_role('button', name='Copy commit hash bbbbbbb', exact=True).click()
    expect(git.get_by_text('Copied', exact=True)).to_be_visible()
    git.screenshot(path=str(output / 'git-history.png'))
    git.get_by_role('button', name='Clear search', exact=True).click()
    git.get_by_role('button', name='Choose branch', exact=True).click()
    page.get_by_role('textbox', name='Find or create branch', exact=True).fill('main')
    page.get_by_role('button', name='main', exact=True).click()
    expect(git.get_by_role('button', name='Choose branch', exact=True)).to_contain_text('main')
    expect(commits).to_have_count(20)
    git.get_by_role('button', name=re.compile('^Changes')).click()
    page.set_viewport_size({'width': 390, 'height': 844})
    # Narrowing the window closes the tools panel; reopen it at mobile width.
    expect(git).to_have_count(0)
    page.get_by_role('button', name='Git', exact=True).first.click()
    expect(git.get_by_role('textbox', name='Commit message', exact=True)).to_be_visible()
    assert git.evaluate('(element) => element.scrollWidth <= element.clientWidth + 1')
    assert git.bounding_box()['width'] <= 390
    git.screenshot(path=str(output / 'git-mobile.png'))
    page.evaluate("document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light')")
    git.screenshot(path=str(output / 'git-mobile-light.png'))
    empty = True
    git.get_by_role('button', name='Refresh Git', exact=True).click()
    expect(git.get_by_role('heading', name='Every change, in view.', exact=True)).to_be_visible()
    git.screenshot(path=str(output / 'git-empty.png'))
    assert not errors, errors
    context.close()
    browser.close()
print('PASS: staged/unstaged diffs, staging, staged commit, visible errors, filters, infinite history scroll, history retry, refresh preservation, clipboard, branch reset, mobile/light layout, empty state')
