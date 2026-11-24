"""Browser regression checks for workspace settings, usage and logs."""
import argparse
import json
import tempfile
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser(description="Workspace settings, usage and request logs browser checks with mocked APIs.")
parser.add_argument('--base-url', default='http://127.0.0.1:4193')
parser.add_argument('--browser-executable')
parser.add_argument('--output', default=str(Path(tempfile.gettempdir()) / 'neuronrunner-workspace-verification'))
args = parser.parse_args()
base = args.base_url.rstrip('/')
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)
user = {'uuid': 'user-1', 'username': 'Tester', 'email': 'tester@example.com', 'first_name': 'Test'}
workspaces = [dict(uuid=f'workspace-{n}', name=f'Test workspace {n}', slug=f'test-{n}', user_role='owner', member_count=1, members=[], pending_invitations=[], balance='25.00') for n in [1, 2]]
errors, log_requests = [], []

def api(route):
    req = route.request
    path = urlparse(req.url).path.rstrip('/')
    if req.url.startswith(base):
        route.continue_(); return
    if 'google' in req.url or 'gstatic' in req.url:
        route.fulfill(content_type='application/javascript', body=''); return
    if req.method == 'OPTIONS':
        route.fulfill(status=204, headers={'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*'}); return
    if path.endswith('/auth/refresh'): data = {'access': 'test-token'}
    elif path.endswith('/users/me'): data = user
    elif path.endswith('/sandbox/workspaces'): data = workspaces
    elif path.endswith('/sandbox/sandbox-tools/list'):
        workspace_uuid = req.headers.get('x-workspace-id', 'workspace-1')
        data = {'sandboxes': [], 'workspace_sandbox': {'uuid': 'filesystem-' + workspace_uuid, 'workspace_uuid': workspace_uuid, 'display_name': 'Files', 'status': 'stopped', 'sandbox_cpu': 1, 'sandbox_memory': 4096}}
    elif path.endswith('/users/balance'): data = {'balance': '25.00'}
    elif path.endswith('/billing/transactions'): data = {'transactions': []}
    elif path.endswith('/provider-keys'): data = {'keys': []}
    elif path.endswith('/billing/usage'): data = {'totals': {'requests': 3, 'input_tokens': 10, 'output_tokens': 5, 'charged_cost': '1.00'}, 'models': [], 'users': [{'user_uuid': 'user-1', 'username': 'Tester', 'display_name': 'Test User', 'requests': 3, 'input_tokens': 10, 'output_tokens': 5, 'cached_input_tokens': 0, 'charged_cost': '1.00', 'compute_cost': 0}]}
    elif path.endswith('/billing/logs'):
        from urllib.parse import parse_qs
        params = parse_qs(urlparse(req.url).query)
        log_requests.append({'params': params, 'workspace': req.headers.get('x-workspace-id')})
        row = {'uuid': 'log-1', 'created_at': '2026-10-14T12:30:00Z', 'user_uuid': 'user-1', 'username': 'Tester', 'display_name': 'Test User', 'model': 'Test model', 'provider': 'openrouter', 'status': 'completed', 'input_tokens': 10, 'output_tokens': 5, 'cached_input_tokens': 3, 'charged_cost': '0.123456', 'cost': '0.123456', 'uses_byok': False, 'duration_seconds': 3}
        empty = params.get('status') == ['failed']
        data = {'logs': [] if empty else [dict(row, uuid='log-2' if params.get('offset') == ['25'] else 'log-1')], 'total': 0 if empty else 26, 'limit': 25, 'offset': int(params.get('offset', ['0'])[0]), 'users': [{'user_uuid': 'user-1', 'username': 'Tester', 'display_name': 'Test User'}]}
    elif path.endswith('/conversations'): data = {'conversations': [], 'has_next': False}
    elif path.endswith('/models'): data = {'results': [], 'count': 0}
    else: data = []
    route.fulfill(content_type='application/json', body=json.dumps(data), headers={'Access-Control-Allow-Origin': '*'})

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, **({'executable_path': args.browser_executable} if args.browser_executable else {}))
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    context.route('**/*', api)
    context.add_init_script("""
      localStorage.setItem('token', 'test-token');
      localStorage.setItem('refreshToken', 'test-refresh');
      localStorage.setItem('user', JSON.stringify({uuid: 'user-1', username: 'Tester', email: 'tester@example.com', first_name: 'Test'}));
      localStorage.setItem('sidebar-storage', JSON.stringify({state: {isOpen: true}, version: 0}));
      localStorage.setItem('theme', 'dark');
    """)
    page = context.new_page()
    page.on('pageerror', lambda err: errors.append(str(err)))
    page.goto(base)
    page.get_by_role('button', name='Account and workspace menu').click()
    expect(page.get_by_role('menuitem', name='Workspace settings', exact=True)).to_have_count(0)
    expect(page.get_by_role('menuitem', name='New workspace', exact=True)).to_have_count(0)
    page.get_by_role('menuitem', name='Settings', exact=True).click()
    dialog = page.get_by_role('dialog', name='Settings', exact=True)
    expect(dialog).to_be_visible()
    expect(dialog.get_by_label('Workspace name')).to_have_value('Test workspace 1')
    expect(dialog.get_by_role('button', name='Profile', exact=True)).to_have_count(0)
    bounds = dialog.bounding_box()
    assert bounds['x'] > 0 and bounds['y'] > 0 and bounds['height'] < 1000
    dialog.get_by_role('button', name='Provider keys (BYOK)', exact=True).click()
    expect(dialog.get_by_role('heading', name='Bring your own key')).to_be_visible()
    dialog.get_by_role('button', name='Billing', exact=True).click()
    expect(dialog.get_by_role('heading', name='Workspace billing')).to_be_visible()
    dialog.get_by_role('button', name='Usage', exact=True).click()
    expect(dialog.get_by_role('heading', name='Workspace usage')).to_be_visible()
    expect(dialog.get_by_role('heading', name='Usage by user')).to_be_visible()
    expect(dialog.get_by_text('Test User', exact=True)).to_be_visible()
    dialog.get_by_role('button', name='Logs', exact=True).click()
    expect(dialog.get_by_role('heading', name='Request logs')).to_be_visible()
    expect(dialog.get_by_text('$0.123456', exact=True)).to_be_visible()
    expect(dialog.get_by_text('Test model', exact=True)).to_be_visible()
    dialog.get_by_role('button', name='Next logs page').click()
    expect(dialog.get_by_text('Page 2 of 2', exact=True)).to_be_visible()
    dialog.get_by_role('combobox', name='Log status').click()
    page.get_by_role('option', name='failed', exact=True).click()
    dialog.get_by_role('button', name='Apply filters').click()
    expect(dialog.get_by_text('No requests found', exact=True)).to_be_visible()
    dialog.get_by_role('button', name='Reset', exact=True).click()
    expect(dialog.get_by_text('$0.123456', exact=True)).to_be_visible()
    dialog.get_by_role('combobox', name='Log user').click()
    page.get_by_role('option', name='Test User (@Tester)', exact=True).click()
    dialog.get_by_role('button', name='Apply filters').click()
    expect(dialog.get_by_text('Test model', exact=True)).to_be_visible()
    dialog.get_by_label('From (UTC)', exact=True).fill('2026-10-01')
    dialog.get_by_label('To (UTC)', exact=True).fill('2026-10-14')
    dialog.get_by_role('button', name='Apply filters').click()
    expect(dialog.get_by_text('Test model', exact=True)).to_be_visible()
    assert any(item['params'].get('offset') == ['25'] for item in log_requests)
    assert any(item['params'].get('status') == ['failed'] for item in log_requests)
    assert any(item['params'].get('user_uuid') == ['user-1'] and item['params'].get('from') == ['2026-10-01'] and item['params'].get('to') == ['2026-10-14'] for item in log_requests)
    dialog.get_by_role('button', name='Usage', exact=True).click()
    dialog.get_by_role('button', name='Settings workspace', exact=True).click()
    expect(page.get_by_role('menuitem', name='New workspace', exact=True)).to_be_visible()
    page.get_by_role('menuitem', name='Test workspace 2', exact=True).click()
    expect(dialog.get_by_text('Usage across Test workspace 2, including all team members.')).to_be_visible()
    dialog.get_by_role('button', name='Workspace', exact=True).click()
    expect(dialog.get_by_label('Workspace name')).to_have_value('Test workspace 2')
    dialog.get_by_role('button', name='Team', exact=True).click()
    expect(dialog.get_by_role('heading', name='Team members')).to_be_visible()
    dialog.get_by_role('button', name='Usage', exact=True).click()
    expect(dialog.get_by_role('heading', name='Usage by user')).to_be_visible()
    page.wait_for_timeout(300)
    page.screenshot(path=str(output / 'workspace-modal-desktop.png'))
    dialog.get_by_role('button', name='Logs', exact=True).click()
    expect(dialog.get_by_text('$0.123456', exact=True)).to_be_visible()
    page.wait_for_timeout(300)
    page.screenshot(path=str(output / 'workspace-logs-desktop.png'))
    page.keyboard.press('Escape')
    expect(page.get_by_role('dialog')).to_have_count(0)
    page.get_by_role('button', name='Account and workspace menu').click()
    page.get_by_role('menuitem', name='Settings', exact=True).click()
    account = page.get_by_role('dialog', name='Settings', exact=True)
    expect(account.get_by_role('button', name='Profile', exact=True)).to_be_visible()
    expect(account.get_by_label('Settings workspace')).to_have_count(0)
    expect(account.get_by_role('button', name='Billing', exact=True)).to_have_count(0)
    account.get_by_role('button', name='Close settings').click()
    expect(page.get_by_role('dialog')).to_have_count(0)
    for route, button in [('/billing/cancel', 'Back to Billing'), ('/billing/success', 'Go to Billing')]:
        page.goto(base + route)
        page.get_by_role('button', name=button, exact=True).click()
        expect(page.get_by_role('dialog', name='Settings', exact=True)).to_be_visible()
        expect(page.get_by_role('heading', name='Workspace billing')).to_be_visible()
        page.get_by_role('button', name='Close settings').click()
    page.goto(base + '/settings/subscription')
    expect(page.get_by_role('dialog', name='Settings', exact=True)).to_be_visible()
    expect(page.get_by_role('heading', name='Workspace billing')).to_be_visible()
    page.get_by_role('button', name='Close settings').click()
    page.get_by_role('button', name='Close sidebar', exact=True).click()
    page.set_viewport_size({'width': 390, 'height': 844})
    page.goto(base + '/billing/cancel')
    page.get_by_role('button', name='Close sidebar', exact=True).click()
    page.get_by_role('button', name='Back to Billing').click()
    dialog = page.get_by_role('dialog', name='Settings', exact=True)
    expect(dialog).to_be_visible()
    bounds = dialog.bounding_box()
    assert bounds['x'] >= 15 and bounds['y'] >= 15
    assert bounds['width'] <= 358 and bounds['height'] <= 812
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    dialog.get_by_role('button', name='Workspace', exact=True).click()
    expect(dialog.get_by_label('Workspace name')).to_be_visible()
    page.wait_for_timeout(300)
    page.screenshot(path=str(output / 'workspace-modal-mobile.png'))
    dialog.get_by_role('button', name='Logs', exact=True).click()
    expect(dialog.get_by_text('$0.123456', exact=True)).to_be_visible()
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.wait_for_timeout(300)
    page.screenshot(path=str(output / 'workspace-logs-mobile.png'))
    dialog.get_by_role('button', name='Close settings').click()
    expect(page.get_by_role('dialog')).to_have_count(0)
    assert any(item['workspace'] == 'workspace-2' for item in log_requests)
    assert not errors, errors
    browser.close()
    print('PASS: separate modals, workspace selector, user usage, Logs pagination/user/status/date filters, workspace isolation, team dialog, close/Escape, billing return routes, desktop/mobile layout, no browser errors')
