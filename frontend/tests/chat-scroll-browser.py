"""Chat viewport and title animation checks against a Vite dev server, with mocked APIs."""
import argparse
import json
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--base-url', default='http://127.0.0.1:4195')
args = parser.parse_args()
base = args.base_url.rstrip('/')
user = {'uuid': 'scroll-user', 'username': 'Tester', 'email': 'test@example.com'}
model = {'uuid': 'scroll-model', 'name': 'scroll-model', 'model_type': 'text', 'default_tag': 'latest'}
history = [
    {'uuid': f'message-{i}', 'role': 'user' if i % 2 == 0 else 'assistant',
     'content': f'History {i}', 'created_at': f'2026-10-15T00:00:{i:02d}Z'}
    for i in range(20)
]
pending = []
errors = []


def api(route):
    request = route.request
    if request.url.startswith(base):
        route.continue_()
        return
    path = urlparse(request.url).path.rstrip('/')
    if request.method == 'OPTIONS':
        route.fulfill(status=204, headers={'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*'})
        return
    if path.endswith('/v1/chat/completions'):
        pending.append(route)
        return
    if path.endswith('/users/me'):
        data = user
    elif path.endswith('/auth/refresh'):
        data = {'access': 'scroll-token'}
    elif path.endswith('/conversations/scroll-chat'):
        data = {'conversation': {'uuid': 'scroll-chat', 'title': 'Scroll test', 'messages': history, 'active_request': None}}
    elif path.endswith('/conversations'):
        data = {'conversations': [{'uuid': 'scroll-chat', 'title': 'Scroll test'}], 'has_next': False}
    elif path.endswith('/recent-models'):
        data = [model]
    elif '/models/' in path:
        data = model
    elif path.endswith('/models'):
        data = {'results': [model], 'count': 1}
    elif path.endswith('/sandbox/workspaces'):
        data = [{'uuid': 'workspace-1', 'name': 'Workspace', 'slug': 'workspace', 'user_role': 'owner', 'is_personal': True}]
    elif path.endswith('/sandbox/sandbox-tools/list'):
        data = {'sandboxes': [], 'workspace_sandbox': None}
    else:
        data = []
    route.fulfill(content_type='application/json', body=json.dumps(data), headers={'Access-Control-Allow-Origin': '*'})


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, reduced_motion='no-preference')
    context.route('**/*', api)
    context.add_init_script("""
        localStorage.setItem('token', 'scroll-token');
        localStorage.setItem('refreshToken', 'scroll-refresh');
        localStorage.setItem('user', JSON.stringify(%s));
        localStorage.setItem('sidebar-storage', JSON.stringify({state: {isOpen: false}, version: 0}));
    """ % json.dumps(user))
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base + '/chat/scroll-chat')
    expect(page.get_by_text('History 19', exact=True)).to_be_visible()
    page.evaluate("""async () => {
        window.scrollTestStore = (await import('/src/stores/chat.ts')).default;
        window.titleTestStore = (await import('/src/stores/sidebar.ts')).default;
    }""")
    title = page.locator('.workspace-screen button[title$="(Click to rename)"] .title-fade-in')
    page.evaluate("titleTestStore.getState().setConversationTitle('scroll-chat', 'Scroll test')")
    expect(title).to_have_text('Scroll test')
    page.wait_for_timeout(350)
    assert title.evaluate("el => { for (let node = el; node; node = node.parentElement) if (getComputedStyle(node).transform !== 'none') return false; return true; }")

    samples = page.evaluate("""async () => {
        const title = document.querySelector('.workspace-screen button[title$="(Click to rename)"] .title-fade-in');
        titleTestStore.getState().setConversationTitle('scroll-chat', 'Updated title');
        const samples = [], start = performance.now();
        while (performance.now() - start < 500) {
            await new Promise(requestAnimationFrame);
            samples.push({text: title.textContent, opacity: Number(getComputedStyle(title.firstElementChild).opacity)});
        }
        return samples;
    }""")
    assert any(sample['text'] == 'Scroll test' and sample['opacity'] < 0.5 for sample in samples), samples
    assert any(sample['text'] == 'Updated title' and sample['opacity'] < 0.5 for sample in samples), samples
    assert samples[-1] == {'text': 'Updated title', 'opacity': 1}, samples[-1]

    # Pending changes cannot reveal an obsolete title or leave the current one hidden.
    page.evaluate("""() => {
        titleTestStore.getState().setConversationTitle('scroll-chat', 'Obsolete title');
        setTimeout(() => titleTestStore.getState().setConversationTitle('scroll-chat', 'Latest title'), 50);
    }""")
    expect(title).to_have_text('Latest title')
    page.wait_for_timeout(350)
    page.evaluate("""() => {
        titleTestStore.getState().setConversationTitle('scroll-chat', 'Cancelled title');
        setTimeout(() => titleTestStore.getState().setConversationTitle('scroll-chat', 'Latest title'), 50);
    }""")
    page.wait_for_timeout(350)
    expect(title).to_have_text('Latest title')
    assert title.locator('span').evaluate('(el) => getComputedStyle(el).opacity') == '1'
    print('PASS: title uses opacity only; changes fade out/in; rapid updates and cancellation settle correctly', flush=True)

    # The same title DOM node must survive streaming and completion without replaying.
    page.evaluate("""() => {
        window.originalTitleNode = document.querySelector('.workspace-screen .title-fade-in');
        window.titleAnimationEvents = [];
        document.addEventListener('animationstart', event => {
            if (event.target === originalTitleNode || event.target.contains(originalTitleNode)) titleAnimationEvents.push(event.animationName);
        });
        originalTitleNode.firstElementChild.addEventListener('transitionstart', event => titleAnimationEvents.push(event.propertyName));
    }""")
    page.locator('textarea').first.fill('Latest prompt')
    page.get_by_role('button', name='Send message', exact=True).click()
    expect(page.get_by_role('button', name='Stop generation', exact=True)).to_be_visible()

    # A real send must align the latest prompt before the first stream token.
    aligned = """() => {
        const container = document.querySelector('#chat-scroll-container');
        const prompt = [...container.querySelectorAll('p')].find(node => node.textContent === 'Latest prompt');
        return prompt && Math.abs(prompt.closest('.mb-2').getBoundingClientRect().top - container.getBoundingClientRect().top - 24) < 2;
    }"""
    page.wait_for_function(aligned)
    print('PASS: loading reserves a viewport and aligns the latest prompt', flush=True)

    # Partial replies and model startup preserve the same position.
    page.evaluate("scrollTestStore.setState({useModelStartingLoading: true})")
    page.wait_for_function(aligned)
    page.evaluate("scrollTestStore.setState({useModelStartingLoading: false, currentMessage: {role: 'assistant', type: 'text', content: 'Short reply'}})")
    expect(page.get_by_text('Short reply', exact=True)).to_be_visible()
    page.wait_for_function(aligned)
    for viewport in [{'width': 390, 'height': 844}, {'width': 1440, 'height': 1000}]:
        page.set_viewport_size(viewport)
        page.wait_for_function(aligned)
    print('PASS: short streaming replies and desktop/mobile resizing preserve alignment', flush=True)

    # Once the reply exceeds the viewport, its end remains visible.
    long_reply = '\n\n'.join(f'Long reply paragraph {i}.' for i in range(60))
    page.evaluate('(content) => scrollTestStore.setState({currentMessage: {role: "assistant", type: "text", content}})', long_reply)
    page.wait_for_function("""() => {
        const el = document.querySelector('#chat-scroll-container');
        return el.scrollHeight - el.clientHeight - el.scrollTop < 2;
    }""")
    expect(page.get_by_text('Long reply paragraph 59.', exact=True)).to_be_visible()

    # Reading earlier messages must stop following the stream.
    page.locator('#chat-scroll-container').hover()
    page.mouse.wheel(0, -700)
    page.wait_for_timeout(350)
    before = page.locator('#chat-scroll-container').evaluate('(el) => el.scrollTop')
    page.evaluate('(content) => scrollTestStore.setState({currentMessage: {role: "assistant", type: "text", content}})', long_reply + '\n\nAnother paragraph.')
    page.wait_for_timeout(350)
    after = page.locator('#chat-scroll-container').evaluate('(el) => el.scrollTop')
    assert abs(before - after) < 2, (before, after)
    print('PASS: long replies follow their end; scrolling to history stops following', flush=True)

    # Completion keeps the reserved area for a short answer.
    page.evaluate("""() => {
        const state = scrollTestStore.getState();
        scrollTestStore.setState({isStreaming: false, currentMessage: null,
          messages: [...state.messages, {uuid: 'finished-reply', parent: state.messages.findLast(message => message.role === 'user').uuid,
            role: 'assistant', type: 'text', content: 'Finished reply', created_at: new Date().toISOString()}]});
    }""")
    expect(page.get_by_text('Finished reply', exact=True)).to_be_visible()
    assert not page.get_by_text('Finished reply', exact=True).evaluate("el => Boolean(el.closest('.chat-enter'))")
    assert page.evaluate("originalTitleNode === document.querySelector('.workspace-screen .title-fade-in')")
    assert page.evaluate('titleAnimationEvents') == []
    print('PASS: generation completion does not replay title or reply entrance animations', flush=True)
    page.locator('#chat-scroll-container').evaluate('(el) => { el.scrollTop = el.scrollHeight; }')
    page.wait_for_function(aligned)
    assert not errors, errors
    for route in pending:
        route.fulfill(content_type='text/event-stream', body='data: [DONE]\n\n', headers={'Access-Control-Allow-Origin': '*'})
    page.wait_for_timeout(250)
    page.emulate_media(reduced_motion='reduce')
    page.evaluate("titleTestStore.getState().setConversationTitle('scroll-chat', 'Reduced motion title')")
    expect(title).to_have_text('Reduced motion title')
    assert title.evaluate('(el) => getComputedStyle(el).animationName') == 'none'
    browser.close()
    print('PASS: completion preserves short reply layout; no browser errors', flush=True)
