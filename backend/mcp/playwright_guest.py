"""Workspace-only browser preparation for the standard Playwright MCP package.

Chrome runs independently of short-lived stdio clients. CDP stays on loopback;
neither its endpoint nor provider credentials are published to the browser UI.
"""
import fcntl
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import socket
import subprocess
import time
from urllib.request import ProxyHandler, build_opener

BROWSER_ROOT = Path('/var/lib/neuronrunner/playwright')
CDP_PORT = 9222
CDP_URL = f'http://127.0.0.1:{CDP_PORT}'


def managed_playwright(command, env):
    args = shlex.split(command) if isinstance(command, str) else command
    if not args or os.path.basename(args[0]) not in ('npx', 'npm'):
        return False
    package_args = args[1:]
    if os.path.basename(args[0]) == 'npm':
        if not package_args or package_args[0] != 'exec':
            return False
        package_args = package_args[1:]
    package = next((arg for arg in package_args if not arg.startswith('-')), '')
    if not (package == '@playwright/mcp' or package.startswith('@playwright/mcp@')):
        return False
    # Explicit custom browser/connection settings remain under the user's control.
    options = {'--cdp-endpoint', '--endpoint', '--extension', '--browser', '--executable-path', '--config',
               '--user-data-dir', '--isolated'}
    variables = {'PLAYWRIGHT_MCP_CDP_ENDPOINT', 'PLAYWRIGHT_MCP_ENDPOINT', 'PLAYWRIGHT_MCP_EXTENSION',
                 'PLAYWRIGHT_MCP_BROWSER', 'PLAYWRIGHT_MCP_EXECUTABLE_PATH', 'PLAYWRIGHT_MCP_CONFIG',
                 'PLAYWRIGHT_MCP_USER_DATA_DIR', 'PLAYWRIGHT_MCP_ISOLATED'}
    return not (any(arg.split('=', 1)[0] in options for arg in args[1:]) or any(env.get(key) for key in variables))


def cdp_ready():
    try:
        with build_opener(ProxyHandler({})).open(CDP_URL + '/json/version', timeout=1) as response:
            data = json.loads(response.read(65536))
        return str(data.get('Browser', '')).startswith(('Chrome/', 'Chromium/', 'HeadlessChrome/'))
    except (OSError, ValueError):
        return False


def browser_owner(profile):
    try:
        state = json.loads((BROWSER_ROOT / 'browser.json').read_text())
        args = Path(f"/proc/{int(state['pid'])}/cmdline").read_bytes().split(b'\0')
        if f'--user-data-dir={profile}'.encode() in args and f'--remote-debugging-port={CDP_PORT}'.encode() in args:
            return state
    except (OSError, ValueError, TypeError, KeyError):
        pass
    return None


def prepare_playwright(command, env):
    if not managed_playwright(command, env):
        return
    BROWSER_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    profile = BROWSER_ROOT / 'profile'
    args = shlex.split(command) if isinstance(command, str) else command
    headless = '--headless' in args or str(env.get('PLAYWRIGHT_MCP_HEADLESS', '')).lower() in ('true', '1')
    display = env.get('DISPLAY') or (':1' if Path('/tmp/.X11-unix/X1').exists() else '')
    mode = 'headed' if display and not headless else 'headless'
    # Package installers and Chrome receive only workspace/browser environment.
    browser_env = {key: env[key] for key in ('PATH', 'HOME', 'LANG', 'TMPDIR', 'XAUTHORITY', 'XDG_RUNTIME_DIR') if key in env}
    if mode == 'headed':
        browser_env['DISPLAY'] = display
    with (BROWSER_ROOT / 'browser.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        owner = browser_owner(profile)
        if owner and owner.get('mode') == mode and cdp_ready():
            env['PLAYWRIGHT_MCP_CDP_ENDPOINT'] = CDP_URL
            return
        if owner:
            # Switch a managed headless browser to KDE when the desktop opens.
            os.kill(owner['pid'], signal.SIGTERM)
            for _ in range(100):
                if not browser_owner(profile):
                    break
                time.sleep(0.05)
            else:
                raise RuntimeError('MCP browser is still shutting down. Try again.')
        with socket.socket() as probe:
            if probe.connect_ex(('127.0.0.1', CDP_PORT)) == 0:
                raise RuntimeError('MCP browser port 9222 is already used by another workspace service.')
        executable = next((path for path in ('/opt/google/chrome/chrome', shutil.which('google-chrome'),
                          shutil.which('chromium'), shutil.which('chromium-browser')) if path and Path(path).is_file()), None)
        log_path = BROWSER_ROOT / 'browser.log'
        with log_path.open('ab') as log:
            if executable is None:
                if not shutil.which('npx', path=env.get('PATH')):
                    raise RuntimeError('MCP browser requires Node.js and npx inside the workspace VM.')
                installer = subprocess.Popen(['npx', '-y', 'playwright', 'install', '--with-deps', 'chrome'],
                    stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=browser_env, start_new_session=True)
                try:
                    if installer.wait(timeout=300) != 0:
                        raise RuntimeError('MCP browser installation failed. Check /var/lib/neuronrunner/playwright/browser.log in the VM.')
                except subprocess.TimeoutExpired:
                    raise TimeoutError('MCP browser installation timed out. Reconnect to try again.') from None
                finally:
                    if installer.poll() is None:
                        os.killpg(installer.pid, signal.SIGKILL)
                        installer.wait()
                executable = '/opt/google/chrome/chrome'
            launch = [executable, f'--remote-debugging-port={CDP_PORT}', '--remote-debugging-address=127.0.0.1',
                f'--user-data-dir={profile}', '--no-sandbox', '--test-type', '--disable-dev-shm-usage', '--no-first-run',
                '--no-default-browser-check', '--restore-last-session']
            if mode == 'headless':
                launch.extend(['--window-size=1440,900', '--headless=new'])
            else:
                launch.append('--start-maximized')
            browser = subprocess.Popen(launch, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                       env=browser_env, start_new_session=True)
        ready = False
        try:
            for _ in range(100):
                if browser.poll() is not None:
                    break
                if cdp_ready():
                    temporary = BROWSER_ROOT / 'browser.json.tmp'
                    temporary.write_text(json.dumps({'pid': browser.pid, 'mode': mode}))
                    temporary.chmod(0o600)
                    temporary.replace(BROWSER_ROOT / 'browser.json')
                    env['PLAYWRIGHT_MCP_CDP_ENDPOINT'] = CDP_URL
                    ready = True
                    return
                time.sleep(0.1)
            raise RuntimeError('MCP browser could not start. Check /var/lib/neuronrunner/playwright/browser.log in the VM.')
        finally:
            if not ready and browser.poll() is None:
                os.killpg(browser.pid, signal.SIGKILL)
                browser.wait()
