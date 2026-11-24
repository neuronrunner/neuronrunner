"""Production SPA smoke tests with mocked Django APIs and terminal WebSocket."""
import argparse
import json
import os
import tempfile
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--base-url', default='http://127.0.0.1:4173')
parser.add_argument('--browser-executable')
parser.add_argument('--library-dir')
parser.add_argument('--output', default=str(Path(tempfile.gettempdir()) / 'neuron-vite-verification'))
args = parser.parse_args()
if args.library_dir:
    os.environ['LD_LIBRARY_PATH'] = args.library_dir + os.pathsep + os.environ.get('LD_LIBRARY_PATH', '')
base = args.base_url.rstrip('/')
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)
errors, requests, terminal_messages = [], [], []
workspace_id = '10000000-0000-4000-8000-000000000001'
filesystem_id = '20000000-0000-4000-8000-000000000001'
conversation_id = '30000000-0000-4000-8000-000000000001'
user = {'uuid': '40000000-0000-4000-8000-000000000001', 'username': 'verification-user', 'email': 'verify@example.com'}
workspace = {'uuid': workspace_id, 'name': 'Verification workspace', 'slug': 'verification', 'user_role': 'owner', 'member_count': 1, 'is_personal': True}
filesystem = {'uuid': filesystem_id, 'workspace_uuid': workspace_id, 'filesystem_path': '/workspace', 'display_name': 'Files', 'status': 'stopped'}
model = {'uuid': '50000000-0000-4000-8000-000000000001', 'name': 'migration-model', 'author': user['username'], 'model_type': 'text', 'description': 'Migration verification model', 'readme': 'Model loaded from Django.', 'category': 'text', 'default_tag': 'latest', 'tags': [], 'is_public': True, 'runs': 1, 'likes_count': 0}


def intercept(route):
    request = route.request
    parsed = urlparse(request.url)
    path = parsed.path.rstrip('/') or '/'
    if request.url.startswith(base):
        if path == '/mock-preview':
            route.fulfill(content_type='text/html', body='<h1>Django preview on port 8000</h1>')
        else:
            route.continue_()
        return
    if parsed.netloc.endswith('google.com') or parsed.netloc.endswith('gstatic.com'):
        route.fulfill(content_type='application/javascript', body='')
        return
    requests.append({'path': path, 'method': request.method, 'headers': request.headers})
    if request.method == 'OPTIONS':
        route.fulfill(status=204, headers={'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*'})
        return
    status = 200
    if path.endswith('/auth/refresh'):
        data = {'access': 'verification-access'}
    elif path.endswith('/auth/login'):
        data = {'access': 'verification-access', 'refresh': 'verification-refresh', 'user': user}
    elif path.endswith('/users/me') or path.endswith('/users/verification-user'):
        data = user
    elif path.endswith('/sandbox/workspaces'):
        data = [workspace]
    elif path.endswith('/sandbox/sandbox-tools/list'):
        data = {'sandboxes': [], 'workspace_sandbox': filesystem}
    elif path.endswith('/sandbox/sandboxes'):
        data = []
    elif path.endswith('/users/balance'):
        data = {'balance': '25.00'}
    elif path.endswith('/billing/transactions'):
        data = {'transactions': [{'uuid': 'payment-test', 'created_at': '2026-10-13T00:00:00Z', 'status': 'paid', 'currency': 'USD', 'amount_paid': '20.00'}]}
    elif path.endswith('/billing/top-up/checkout'):
        data = {'checkout_url': base + '/billing/success?session_id=verification-session', 'transaction_id': 'payment-test'}
        status = 201
    elif path.endswith('/port-preview'):
        data = {'ports': [3000, 8000]} if request.method == 'GET' else {'url': base + '/mock-preview'}
    elif path.endswith('/terminal-ticket'):
        data = {'ticket': 'verification-ticket'}
    elif path.endswith('/v1/chat/completions'):
        chunks = [
            {'neuronrunner_metadata': {'conversation_id': conversation_id, 'user_message_uuid': 'sent-user', 'request_id': 'sent-request'}, 'choices': [{'index': 0, 'delta': {'role': 'assistant'}, 'finish_reason': None}]},
            {'choices': [{'index': 0, 'delta': {'content': 'Streaming works after the Vite migration.'}, 'finish_reason': None}]},
            {'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]},
        ]
        body = ''.join('data: ' + json.dumps(chunk) + '\n\n' for chunk in chunks) + 'data: [DONE]\n\n'
        route.fulfill(content_type='text/event-stream', body=body, headers={'Access-Control-Allow-Origin': '*'})
        return
    elif path.endswith('/conversations/' + conversation_id):
        data = {'conversation': {'uuid': conversation_id, 'title': 'Verification conversation', 'active_request': None, 'messages': [{'uuid': 'first-user', 'role': 'user', 'content': 'Saved prompt'}, {'uuid': 'first-answer', 'role': 'assistant', 'content': 'Saved answer', 'parent_uuid': 'first-user'}]}}
    elif path.endswith('/conversations'):
        data = {'conversations': [{'uuid': conversation_id, 'title': 'Verification conversation', 'is_generating': False}], 'has_next': False}
    elif path.endswith('/recent-models'):
        data = [model]
    elif path.endswith('/models'):
        data = {'results': [model], 'count': 1, 'next': None}
    elif '/models/' in path and not path.endswith(('/tags', '/likes', '/discussions', '/gallery', '/gpus')):
        data = model
    elif path.endswith('/images') or '/images/verification-user' in path:
        data = {'results': [], 'categories': [], 'has_next': False}
    else:
        data = []
    route.fulfill(status=status, content_type='application/json', body=json.dumps(data), headers={'Access-Control-Allow-Origin': '*'})


def terminal(socket):
    def message(raw):
        data = json.loads(raw)
        terminal_messages.append(data)
        if data.get('type') == 'auth':
            socket.send(json.dumps({'type': 'output', 'data': 'Terminal connected through Vite\r\n$ '}))
    socket.on_message(message)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, **({'executable_path': args.browser_executable} if args.browser_executable else {}))
    anonymous = browser.new_context()
    anonymous.route('**/*', intercept)
    login = anonymous.new_page()
    login.on('pageerror', lambda error: errors.append(str(error)))
    login.goto(base + '/models')
    login.get_by_role('button', name='Sign In', exact=True).first.click()
    login.get_by_placeholder('Enter your email').fill(user['email'])
    login.get_by_placeholder('Enter your password').fill('verification-password')
    login.get_by_role('dialog').get_by_role('button', name='Sign In', exact=True).click()
    login.wait_for_function('localStorage.getItem("token") === "verification-access"')
    assert login.evaluate('localStorage.getItem("refreshToken")') == 'verification-refresh'
    anonymous.close()
    print('PASS: login and token storage', flush=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    context.route('**/*', intercept)
    context.route_web_socket('**/ws/sandbox/terminal/**', terminal)
    context.add_init_script('''
        localStorage.setItem('token', 'verification-access');
        localStorage.setItem('refreshToken', 'verification-refresh');
        localStorage.setItem('user', JSON.stringify(%s));
        localStorage.setItem('sidebar-storage', JSON.stringify({state: {isOpen: true}, version: 0}));
        localStorage.setItem('theme', 'dark');
    ''' % json.dumps(user))
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))

    # Deep-link routing and browser-side detail loading, including page refresh.
    page.goto(base + '/models/migration-model')
    expect(page.get_by_text('migration-model', exact=True).first).to_be_visible()
    page.reload()
    expect(page.get_by_text('migration-model', exact=True).first).to_be_visible()
    page.goto(base + '/models?search=migration')
    expect(page.get_by_role('textbox').first).to_have_value('migration')
    page.goto(base + '/images?search=example')
    expect(page.get_by_role('textbox').first).to_have_value('example')
    print('PASS: deep links, refresh, browser data loading, URL filters', flush=True)

    # Real route parameters and the unchanged OpenAI SSE parser.
    page.goto(base + '/chat/' + conversation_id)
    expect(page.get_by_text('Saved answer', exact=True)).to_be_visible()
    page.locator('textarea').first.fill('Verify streaming')
    page.get_by_role('button', name='Send message', exact=True).click()
    expect(page.get_by_text('Streaming works after the Vite migration.', exact=True)).to_be_visible()
    assert any(item['path'].endswith('/v1/chat/completions') and item['headers'].get('x-workspace-id') == workspace_id for item in requests)
    print('PASS: chat history, SSE, and workspace header', flush=True)

    # Lazy workspace tools: new Django shortcut, iframe, history, terminal auth.
    page.get_by_role('button', name='Browser', exact=True).first.click()
    expect(page.get_by_role('button', name='Django app')).to_be_visible()
    page.get_by_role('button', name='Django app').click()
    expect(page.frame_locator('iframe[title="Workspace web browser"]').get_by_role('heading', name='Django preview on port 8000')).to_be_visible()
    page.get_by_role('button', name='Terminal', exact=True).first.click()
    expect(page.locator('.xterm').first).to_be_visible()
    page.wait_for_function('document.querySelector(".xterm") !== null')
    for _ in range(50):
        if terminal_messages:
            break
        page.wait_for_timeout(100)
    assert any(item.get('ticket') == 'verification-ticket' for item in terminal_messages)
    print('PASS: Browser Django preview and lazy terminal WebSocket', flush=True)

    # Existing payment return routes open the Billing dialog rather than a 404.
    page.goto(base + '/billing/cancel')
    page.get_by_role('button', name='Back to Billing').click()
    expect(page.get_by_role('heading', name='Workspace billing')).to_be_visible()
    expect(page.get_by_text('$25.00', exact=True).last).to_be_visible()
    page.get_by_label('Add workspace credits (USD)').fill('25')
    page.get_by_role('button', name='Add credits', exact=True).click()
    expect(page).to_have_url(base + '/billing/success?session_id=verification-session')
    page.get_by_role('button', name='Go to Billing').click()
    expect(page.get_by_role('heading', name='Workspace billing')).to_be_visible()
    assert any(item['path'].endswith('/billing/top-up/checkout') and item['headers'].get('x-workspace-id') == workspace_id for item in requests)
    page.get_by_role('button', name='Close settings').click()
    expect(page.get_by_role('dialog')).not_to_be_visible()
    page.goto(base + '/settings/subscription')
    expect(page.get_by_role('heading', name='Workspace billing')).to_be_visible()
    page.get_by_role('button', name='Close settings').click()
    expect(page.get_by_role('dialog')).not_to_be_visible()
    page.screenshot(path=str(output / 'desktop.png'))

    # Client-side navigation, theme persistence, mobile rendering, and app 404.
    page.goto(base + '/integrations')
    expect(page.get_by_role('heading', name='Integrations', exact=True)).to_be_visible()
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path=str(output / 'mobile.png'))
    page.goto(base + '/route-that-does-not-exist')
    expect(page.get_by_role('heading', name='404', exact=True)).to_be_visible()
    expect(page.locator('[data-testid="vm-header-trigger"]')).not_to_be_visible()
    assert not errors, errors
    browser.close()

print('PASS: production deep links, refresh, model loading, URL filters, chat SSE, Browser/Django iframe, terminal WebSocket, Billing/checkout, connectors, mobile layout, and 404.')
