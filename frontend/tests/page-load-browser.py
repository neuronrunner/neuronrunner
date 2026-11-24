"""Verify that cold home loads make one API request per required resource."""
import argparse
import json
import os
from collections import Counter
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect
parser = argparse.ArgumentParser()
parser.add_argument('--base-url', default='http://127.0.0.1:4173')
parser.add_argument('--browser-executable')
parser.add_argument('--library-dir')
args = parser.parse_args()
base = args.base_url.rstrip('/')
if args.library_dir:
    os.environ['LD_LIBRARY_PATH'] = args.library_dir + os.pathsep + os.environ.get('LD_LIBRARY_PATH', '')
user = {'uuid': 'fetch-user', 'username': 'Fetch check', 'email': 'check@example.com'}
workspace = {'uuid': 'fetch-workspace', 'name': 'Fetch workspace', 'slug': 'fetch', 'user_role': 'owner', 'member_count': 1}
filesystem = {'uuid': 'fetch-files', 'workspace_uuid': workspace['uuid'], 'filesystem_path': '/workspace', 'display_name': 'Files', 'status': 'stopped'}
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, **({'executable_path': args.browser_executable} if args.browser_executable else {}))
    for persisted in [False, True]:
        for has_filesystem in [False, True]:
            counts, errors = Counter(), []
            context = browser.new_context(viewport={'width': 1440, 'height': 1000})
            def api(route):
                req = route.request
                if req.url.startswith(base): return route.continue_()
                path = urlsplit(req.url).path.rstrip('/')
                if 'google' in req.url: return route.fulfill(content_type='application/javascript', body='')
                if req.method == 'OPTIONS': return route.fulfill(status=204, headers={'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*'})
                if not path.endswith('/auth/refresh'):
                    assert req.headers.get('authorization') == 'Bearer new-access', req.headers
                counts[path] += 1
                data = []
                if path.endswith('/auth/refresh'): data = {'access': 'new-access'}
                elif path.endswith('/sandbox/workspaces'): data = [workspace]
                elif path.endswith('/sandbox/sandbox-tools/list'): data = {'sandboxes': [], 'workspace_sandbox': filesystem if has_filesystem else None}
                elif path.endswith('/users/balance'): data = {'balance': '0.00'}
                elif path.endswith('/conversations'): data = {'conversations': [], 'has_next': False}
                route.fulfill(content_type='application/json', body=json.dumps(data), headers={'Access-Control-Allow-Origin': '*'})
            context.route('**/*', api)
            context.add_init_script('''
                localStorage.setItem('token', 'old-access');
                localStorage.setItem('refreshToken', 'refresh-token');
                localStorage.setItem('user', JSON.stringify(%s));
                localStorage.setItem('sidebar-storage', JSON.stringify({state: {isOpen: true}, version: 0}));
                %s
            ''' % (json.dumps(user), "localStorage.setItem('team-workspaces-storage', JSON.stringify({state: {currentWorkspaceUuid: 'fetch-workspace'}, version: 0}));" if persisted else ''))
            page = context.new_page()
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(base, wait_until='networkidle')
            expect(page.get_by_role('button', name='Choose project: No project')).to_be_visible()
            page.wait_for_timeout(500)
            print(json.dumps({'persisted': persisted, 'filesystem': has_filesystem, 'requests': dict(counts), 'errors': errors}), flush=True)
            assert not errors, errors
            assert counts['/sandbox/workspaces'] == 1, counts
            assert counts['/sandbox/sandbox-tools/list'] == 1, counts
            assert counts['/users/balance'] == 1, counts
            assert counts['/recent-models'] == 1, counts
            assert counts['/sandbox/sandboxes'] == 0, counts
            assert counts['/conversations'] == int(has_filesystem), counts
            sidebar = page.get_by_role('complementary', name='Sidebar')
            sidebar_node = sidebar.element_handle()
            conversation_requests = counts['/conversations']
            sidebar.get_by_role('button', name='Integrations', exact=True).click()
            expect(page.get_by_role('heading', name='Integrations', exact=True)).to_be_visible()
            page.wait_for_load_state('networkidle')
            assert sidebar.evaluate('(node, original) => node === original', sidebar_node), 'Connectors remounted the sidebar'
            assert counts['/conversations'] == conversation_requests, counts
            page.go_back(wait_until='networkidle')
            expect(page.get_by_role('button', name='Choose project: No project')).to_be_visible()
            assert sidebar.evaluate('(node, original) => node === original', sidebar_node), 'Returning from Connectors remounted the sidebar'
            assert counts['/conversations'] == conversation_requests, counts
            assert not errors, errors
            context.close()
    browser.close()
