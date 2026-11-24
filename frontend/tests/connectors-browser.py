"""Browser checks with mocked account and MCP APIs. Run against a local dev server."""
import argparse
import json
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--base-url', default='http://127.0.0.1:3000')
parser.add_argument('--browser-executable')
parser.add_argument('--output', default=str(Path(tempfile.gettempdir()) / 'neuron-connectors-verification'))
args = parser.parse_args()
out = Path(args.output)
out.mkdir(exist_ok=True)
servers = []
fail_test = False
requests = []
errors = []
oauth_attempts = {}
oauth_denied = False

def api(route):
    global fail_test
    request = route.request
    path = request.url.split(':8000')[-1]
    data = request.post_data_json if request.post_data else {}
    requests.append((request.method, path, data))
    status = 200
    if path == '/auth/refresh/':
        result = {'access': 'connector-test-token'}
    elif path == '/mcp/' and request.method == 'GET':
        result = servers
    elif path == '/mcp/' and request.method == 'POST':
        result = {'uuid': f'test-server-{len(servers) + 1}', 'tools': [{'name': 'test_tool', 'description': 'Test tool'}], 'has_headers': bool(data.get('headers_json')), 'has_environment': bool(data.get('env_json')), **{k: v for k, v in data.items() if k not in ['headers_json', 'env_json']}}
        servers.append(result)
        status = 201
    elif '/oauth/start/' in path:
        server_id = path.strip('/').split('/')[1]
        state = 'mock-state-' + server_id
        oauth_attempts[state] = {'server_id': server_id, 'secret': 'mock-completion-secret', 'complete': False}
        result = {'authorization_url': 'https://oauth.connector-test.example/authorize?' + urlencode({'state': state}), 'state': state, 'completion_secret': 'mock-completion-secret', 'attempt_id': state}
    elif path == '/mcp/oauth/complete/':
        pending = oauth_attempts[data['state']]
        assert data['completion_secret'] == pending['secret']
        if data.get('error'):
            result = {'error': 'Authorization was cancelled or declined. Connect your account again.'}
            status = 400
        else:
            assert data['code'] == 'mock-authorization-code'
            server = next(item for item in servers if item['uuid'] == pending['server_id'])
            server.update(enabled=True, auth_type='oauth', oauth_connected=True)
            pending['complete'] = True
            result = server
    elif '/oauth/status/' in path:
        pending = oauth_attempts[parse_qs(urlsplit(request.url).query)['attempt'][0]]
        server = next(item for item in servers if item['uuid'] == pending['server_id'])
        result = {'status': 'connected' if pending['complete'] else 'pending', 'server': server}
    elif path.endswith('/test/'):
        result = {'error': 'Invalid access token'} if fail_test else {'success': True, 'tool_count': 1}
        status = 500 if fail_test else 200
    elif path.startswith('/mcp/') and request.method == 'PATCH':
        server = next(item for item in servers if item['uuid'] == path.strip('/').split('/')[1])
        server.update({k: v for k, v in data.items() if k not in ['headers_json', 'env_json']})
        result = server
    elif path.startswith('/mcp/') and request.method == 'DELETE':
        server_id = path.strip('/').split('/')[1]
        servers[:] = [item for item in servers if item['uuid'] != server_id]
        result = {'success': True}
    elif path.startswith('/sandbox/workspaces'):
        result = [{'uuid': 'test-workspace-id', 'name': 'Test workspace', 'slug': 'test', 'balance': '0.00', 'user_role': 'owner', 'members': [], 'pending_invitations': []}]
    elif path.startswith('/billing/'):
        result = {'balance': '0.00'}
    else:
        result = []
    route.fulfill(status=status, content_type='application/json', body=json.dumps(result), headers={'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*'})

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, **({"executable_path": args.browser_executable} if args.browser_executable else {}))
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, device_scale_factor=1)
    context.route('http://localhost:8000/**', api)
    def oauth_provider(route):
        params = parse_qs(urlsplit(route.request.url).query)
        assert 'connector-test-token' not in route.request.url
        assert 'mock-completion-secret' not in route.request.url
        callback = args.base_url.rstrip('/') + '/integrations/oauth/callback?' + urlencode({'state': params['state'][0], **({'error': 'access_denied'} if oauth_denied else {'code': 'mock-authorization-code', 'iss': 'https://oauth.connector-test.example'})})
        route.fulfill(status=302, headers={'Location': callback}, body='')
    context.route('https://oauth.connector-test.example/**', oauth_provider)
    context.add_init_script('''
      localStorage.setItem('token', 'connector-test-token');
      localStorage.setItem('refreshToken', 'connector-test-refresh');
      localStorage.setItem('user', JSON.stringify({uuid: 'connector-test-user', username: 'Designer', email: 'designer@example.com'}));
      localStorage.setItem('sidebar-storage', JSON.stringify({state: {isOpen: true}, version: 0}));
      localStorage.setItem('theme', 'dark');
    ''')
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(args.base_url.rstrip('/') + '/integrations/', wait_until='networkidle')
    page.wait_for_timeout(1000)
    expect(page.get_by_role('heading', name='Integrations', exact=True)).to_be_visible(timeout=15000)
    sidebar = page.get_by_role('complementary', name='Sidebar')
    if not sidebar.is_visible() or sidebar.bounding_box()['x'] < 0:
        page.get_by_role('button', name='Open sidebar', exact=True).click()
    expect(sidebar.get_by_role('button', name='Integrations', exact=True)).to_be_visible()
    page.screenshot(path=str(out / 'desktop-dark.png'))
    print('Desktop dark screenshot saved', flush=True)
    orbit_icons = page.locator('.connectors-orbit-enter')
    expect(orbit_icons).to_have_count(6)
    assert orbit_icons.evaluate_all('(els) => els.every(el => getComputedStyle(el).animationName === "connectors-orbit-arrive")')
    delays = orbit_icons.evaluate_all('(els) => els.map(el => parseFloat(getComputedStyle(el).animationDelay))')
    assert delays == sorted(delays) and len(set(delays)) == 6
    assert page.locator('.connectors-orbit-float').evaluate_all('(els) => els.every(el => getComputedStyle(el).animationIterationCount === "infinite")')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    grid = page.get_by_test_id('connector-grid')
    page.get_by_role('combobox', name='Sort connectors').click()
    page.get_by_role('option', name='Name: A–Z').click()
    expect(grid.get_by_role('button')).to_have_count(24)
    page.get_by_role('button', name='Show more connectors').click()
    expect(grid.get_by_role('button')).to_have_count(48)
    while page.get_by_role('button', name='Show more connectors').count():
        page.get_by_role('button', name='Show more connectors').click()
    expect(grid.get_by_role('button')).to_have_count(100)
    logos = grid.locator('img')
    expect(logos).to_have_count(100)
    # Decode the full catalog without scrolling hundreds of cards individually.
    logos.evaluate_all('(images) => images.forEach(image => { image.loading = "eager"; })')
    page.wait_for_function("""Array.from(document.querySelectorAll('[data-testid="connector-grid"] img')).every(image => image.complete && image.naturalWidth > 0)""")
    logos.evaluate_all('images => Promise.all(images.map(image => image.decode()))')
    page.get_by_role('combobox', name='Sort connectors').click()
    page.get_by_role('option', name='Featured first').click()
    page.get_by_role('textbox', name='Search connectors').fill('Box')
    box_card = grid.get_by_role('button', name='Configure Box', exact=True)
    expect(box_card).to_be_visible()
    writes_before = len([item for item in requests if item[0] == 'POST' and item[1] == '/mcp/'])
    box_card.click()
    expect(page.get_by_role('heading', name='Set up with the provider', exact=True)).to_be_visible()
    expect(page.get_by_role('link', name='Visit provider')).to_have_attribute('href', 'https://box.com')
    expect(page.get_by_role('button', name='Connect', exact=True)).to_have_count(0)
    page.get_by_role('button', name='Add MCP endpoint', exact=True).click()
    expect(page.get_by_role('heading', name='Add a custom connector', exact=True)).to_be_visible()
    expect(page.get_by_label('Server URL', exact=True)).to_have_value('')
    page.keyboard.press('Escape')
    assert len([item for item in requests if item[0] == 'POST' and item[1] == '/mcp/']) == writes_before
    page.get_by_role('button', name='Clear search', exact=True).first.click()
    catalog = json.loads((Path(__file__).parent.parent / 'src/data/connectors.json').read_text())['connectors']
    for category in ['Development', 'Design']:
        category_button = page.get_by_role('button', name=f'Browse {category} connectors')
        expected_count = sum(item['category'] == category for item in catalog)
        category_button.click()
        expect(page.get_by_role('heading', name=category, exact=True)).to_be_visible()
        expect(page.get_by_text(str(expected_count), exact=True)).to_be_visible()
        expect(grid.get_by_role('button')).to_have_count(min(24, expected_count))
        assert all(category in text for text in grid.get_by_role('button').all_text_contents())
        page.get_by_role('button', name='Back to Explore', exact=True).click()
    search = page.get_by_role('textbox', name='Search connectors')
    search.fill('codebase memory')
    expect(grid.get_by_role('button', name='Configure Codebase Memory MCP', exact=True)).to_be_visible()
    grid.get_by_role('button', name='Configure Codebase Memory MCP', exact=True).click()
    expect(page.get_by_role('dialog')).to_be_visible()
    expect(page.get_by_label('Server command', exact=False)).to_have_value('npx -y codebase-memory-mcp@0.12.1')
    page.keyboard.press('Escape')
    search.fill('supabase')
    expect(grid.get_by_role('button', name='Configure Supabase', exact=True)).to_be_visible()
    page.get_by_role('button', name='Clear search', exact=True).first.click()
    search.fill('zzzz-no-such-connector')
    expect(page.get_by_role('heading', name='No connectors found')).to_be_visible()
    page.screenshot(path=str(out / 'empty-search.png'))
    page.get_by_role('button', name='Clear search', exact=True).first.click()
    page.get_by_test_id('connectors-scroll').evaluate('(el) => el.scrollTop = 0')
    page.get_by_role('button', name='Configure GitHub', exact=True).first.click()
    expect(page.get_by_role('dialog')).to_be_visible()
    page.get_by_role('combobox', name='Authentication', exact=True).click()
    page.get_by_role('option', name='API token', exact=True).click()
    page.get_by_label('Authorization', exact=False).fill('Bearer test-token')
    page.screenshot(path=str(out / 'connection-dialog-dark.png'))
    page.get_by_role('button', name='Connect', exact=True).click()
    expect(page.get_by_role('heading', name='Connection verified')).to_be_visible(timeout=15000)
    assert requests[-1][2] == {'enabled': True}
    page.get_by_role('button', name='Done', exact=True).click()
    page.get_by_role('button', name='My connections').click()
    expect(grid.get_by_role('button', name='Configure GitHub', exact=True)).to_be_visible()
    expect(grid.get_by_text('Connected', exact=True)).to_be_visible()
    page.screenshot(path=str(out / 'my-connections.png'))
    grid.get_by_role('button', name='Configure GitHub', exact=True).click()
    page.get_by_role('button', name='Disconnect', exact=True).click()
    expect(page.get_by_role('heading', name='Your next connection starts here')).to_be_visible()
    page.get_by_role('button', name='Explore connectors', exact=True).click()
    page.get_by_test_id('connectors-scroll').evaluate('(el) => el.scrollTop = 0')
    page.get_by_role('button', name='Configure GitHub', exact=True).first.click()
    fail_test = True
    page.get_by_role('combobox', name='Authentication', exact=True).click()
    page.get_by_role('option', name='API token', exact=True).click()
    page.get_by_label('Authorization', exact=False).fill('Bearer invalid-token')
    page.get_by_role('button', name='Connect', exact=True).click()
    expect(page.get_by_role('alert').filter(has_text='Invalid access token')).to_be_visible(timeout=15000)
    assert not servers[0]['enabled']
    fail_test = False
    page.get_by_role('button', name='Save & verify', exact=True).click()
    expect(page.get_by_role('heading', name='Connection verified')).to_be_visible(timeout=15000)
    page.get_by_role('button', name='Done', exact=True).click()
    page.evaluate("localStorage.setItem('theme', 'light'); window.dispatchEvent(new StorageEvent('storage', {key: 'theme', newValue: 'light'}))")
    page.wait_for_timeout(300)
    page.get_by_test_id('connectors-scroll').evaluate('(el) => el.scrollTop = 0')
    page.screenshot(path=str(out / 'desktop-light.png'))
    page.get_by_role('textbox', name='Search connectors').fill('ElevenLabs')
    grid.get_by_role('button', name='Configure ElevenLabs', exact=True).click()
    expect(page.get_by_role('combobox', name='Authentication', exact=True)).to_contain_text('OAuth')
    expect(page.get_by_label('Authorization', exact=False)).to_have_count(0)
    expect(page.get_by_label('Server URL', exact=True)).to_have_value('https://api.us.elevenlabs.io/v1/mcp')
    page.screenshot(path=str(out / 'oauth-connection-dialog.png'))
    with page.expect_popup() as popup_info:
        page.get_by_role('button', name='Connect account', exact=True).click()
    popup_info.value.on('pageerror', lambda error: errors.append(str(error)))
    expect(page.get_by_role('heading', name='Connection verified')).to_be_visible(timeout=15000)
    assert any(path == '/mcp/oauth/complete/' for method, path, data in requests)
    page.get_by_role('button', name='Done', exact=True).click()
    expect(grid.get_by_text('Connected', exact=True)).to_be_visible()
    grid.get_by_role('button', name='Configure ElevenLabs', exact=True).click()
    page.get_by_role('button', name='Disconnect', exact=True).click()
    oauth_denied = True
    grid.get_by_role('button', name='Configure ElevenLabs', exact=True).click()
    with page.expect_popup():
        page.get_by_role('button', name='Connect account', exact=True).click()
    expect(page.get_by_role('alert').filter(has_text='Authorization was cancelled')).to_be_visible(timeout=15000)
    assert not servers[-1]['enabled']
    page.keyboard.press('Escape')
    oauth_denied = False
    page.get_by_role('button', name='Clear search', exact=True).first.click()
    page.get_by_role('button', name='Add custom connector', exact=True).click()
    page.get_by_role('combobox', name='Connection method', exact=True).click()
    page.get_by_role('option', name='Local · stdio', exact=True).click()
    page.get_by_label('Connector name', exact=True).fill('Custom files')
    page.get_by_role('combobox', name='Workspace sandbox', exact=True).click()
    page.get_by_role('option', name='Test workspace', exact=True).click()
    page.get_by_label('Server command', exact=False).fill('npx -y example-server <path>')
    page.get_by_role('button', name='Connect', exact=True).click()
    expect(page.get_by_role('alert').filter(has_text='Replace the placeholders')).to_be_visible()
    page.get_by_label('Server command', exact=False).fill('npx -y example-server')
    page.get_by_role('button', name='Connect', exact=True).click()
    expect(page.get_by_role('heading', name='Connection verified')).to_be_visible(timeout=15000)
    local_request = next(data for method, path, data in reversed(requests) if method == 'POST' and path == '/mcp/')
    assert local_request['workspace'] == 'test-workspace-id'
    assert local_request['transport'] == 'stdio'
    assert local_request['command'] == 'npx -y example-server'
    page.get_by_role('button', name='Done', exact=True).click()
    if sidebar.bounding_box()['x'] >= 0:
        sidebar.get_by_role('button', name='Close sidebar', exact=True).click()
    page.set_viewport_size({'width': 390, 'height': 844})
    page.evaluate("localStorage.setItem('theme', 'dark'); window.dispatchEvent(new StorageEvent('storage', {key: 'theme', newValue: 'dark'}))")
    page.wait_for_timeout(300)
    page.screenshot(path=str(out / 'mobile-dark.png'))
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.get_by_role('button', name='Add custom', exact=True).click()
    expect(page.get_by_role('dialog')).to_be_visible()
    page.screenshot(path=str(out / 'mobile-dialog.png'))
    assert page.get_by_role('dialog').bounding_box()['width'] <= 390
    page.keyboard.press('Escape')
    page.get_by_role('textbox', name='Search connectors').fill('figma')
    expect(grid.get_by_role('button', name='Configure Figma', exact=True).first).to_be_visible()
    page.screenshot(path=str(out / 'mobile-search.png'))
    page.set_viewport_size({'width': 768, 'height': 1024})
    page.get_by_role('textbox', name='Search connectors').fill('')
    page.screenshot(path=str(out / 'tablet.png'))
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.emulate_media(reduced_motion='reduce')
    expect(page.locator('.connectors-orbit-enter').first).to_have_css('animation-name', 'none')
    expect(page.locator('.connectors-orbit-float').first).to_have_css('animation-name', 'none')
    expect(page.locator('.connectors-card-enter').first).to_have_css('animation-name', 'none')
    expect(page.get_by_role('heading', name='Integrations', exact=True)).to_be_visible()
    browser.close()
print('Browser checks passed. Runtime errors:', errors)
assert not errors
Path(out / 'results.json').write_text(json.dumps({'catalogCount': 100, 'passed': True, 'runtimeErrors': errors, 'requests': len(requests)}, indent=2))
