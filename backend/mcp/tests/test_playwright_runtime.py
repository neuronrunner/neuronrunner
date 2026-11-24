from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

from django.test import SimpleTestCase

from mcp import playwright_guest


class PlaywrightRuntimeTests(SimpleTestCase):
    def test_only_standard_playwright_packages_use_managed_browser(self):
        self.assertTrue(playwright_guest.managed_playwright('npx -y @playwright/mcp@0.0.82', {}))
        self.assertTrue(playwright_guest.managed_playwright('npm exec --yes -- @playwright/mcp', {}))
        for command in ('npx -y other-mcp', 'echo @playwright/mcp', 'npx other-mcp @playwright/mcp',
                        'npx @playwright/mcp --browser firefox', 'npx @playwright/mcp --config=/workspace/browser.json',
                        'npx @playwright/mcp --user-data-dir=/workspace/custom-profile', 'npx @playwright/mcp --isolated',
                        'npx @playwright/mcp --cdp-endpoint http://localhost:9000'):
            self.assertFalse(playwright_guest.managed_playwright(command, {}), command)
        self.assertFalse(playwright_guest.managed_playwright('npx @playwright/mcp',
            {'PLAYWRIGHT_MCP_CDP_ENDPOINT': 'http://localhost:9000'}))

    def test_existing_browser_is_reused_without_installing_or_relaunching(self):
        with TemporaryDirectory() as directory, patch.object(playwright_guest, 'BROWSER_ROOT', Path(directory)), \
                patch.object(playwright_guest, 'browser_owner', return_value={'pid': 123, 'mode': 'headed'}), \
                patch.object(playwright_guest, 'cdp_ready', return_value=True), \
                patch.object(playwright_guest.subprocess, 'Popen') as spawn:
            env = {'PATH': '/usr/bin', 'HOME': '/root', 'DISPLAY': ':1'}
            playwright_guest.prepare_playwright(['npx', '-y', '@playwright/mcp'], env)
            self.assertEqual(env['PLAYWRIGHT_MCP_CDP_ENDPOINT'], 'http://127.0.0.1:9222')
            spawn.assert_not_called()

    def test_browser_runs_on_kde_independently_without_connector_secrets(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / 'chrome'
            executable.touch()
            browser = Mock(pid=123)
            browser.poll.return_value = None
            with patch.object(playwright_guest, 'BROWSER_ROOT', root), \
                    patch.object(playwright_guest, 'browser_owner', return_value=None), \
                    patch.object(playwright_guest, 'cdp_ready', return_value=True), \
                    patch.object(playwright_guest.shutil, 'which', return_value=str(executable)), \
                    patch.object(playwright_guest.socket, 'socket') as socket, \
                    patch.object(playwright_guest.subprocess, 'Popen', return_value=browser) as spawn:
                socket.return_value.__enter__.return_value.connect_ex.return_value = 111
                env = {'PATH': '/usr/bin', 'HOME': '/root', 'DISPLAY': ':1', 'MCP_KEY': 'private-connector-key'}
                playwright_guest.prepare_playwright(['npx', '-y', '@playwright/mcp'], env)
                command = spawn.call_args.args[0]
                self.assertIn('--remote-debugging-address=127.0.0.1', command)
                self.assertIn('--no-sandbox', command)
                self.assertIn('--test-type', command)
                self.assertIn('--start-maximized', command)
                self.assertNotIn('--window-size=1440,900', command)
                self.assertNotIn('--headless=new', command)
                self.assertEqual(spawn.call_args.kwargs['env']['DISPLAY'], ':1')
                self.assertNotIn('MCP_KEY', spawn.call_args.kwargs['env'])
                self.assertTrue(spawn.call_args.kwargs['start_new_session'])
                browser.wait.assert_not_called()
                self.assertTrue((root / 'browser.json').is_file())

    def test_explicit_browser_configuration_never_launches_managed_chrome(self):
        with patch.object(playwright_guest.subprocess, 'Popen') as spawn:
            playwright_guest.prepare_playwright(['npx', '@playwright/mcp', '--extension'], {})
            spawn.assert_not_called()

    def test_missing_chrome_is_installed_in_guest_and_can_run_headlessly(self):
        installer = Mock()
        installer.wait.return_value = 0
        installer.poll.return_value = 0
        browser = Mock(pid=123)
        browser.poll.return_value = None
        with TemporaryDirectory() as directory, patch.object(playwright_guest, 'BROWSER_ROOT', Path(directory)), \
                patch.object(playwright_guest, 'browser_owner', return_value=None), \
                patch.object(playwright_guest, 'cdp_ready', return_value=True), \
                patch.object(Path, 'is_file', return_value=False), \
                patch.object(playwright_guest.shutil, 'which', side_effect=lambda command, **kwargs: '/usr/bin/npx' if command == 'npx' else None), \
                patch.object(playwright_guest.socket, 'socket') as socket, \
                patch.object(playwright_guest.subprocess, 'Popen', side_effect=[installer, browser]) as spawn:
            socket.return_value.__enter__.return_value.connect_ex.return_value = 111
            env = {'PATH': '/usr/bin', 'HOME': '/root'}
            playwright_guest.prepare_playwright(['npx', '@playwright/mcp', '--headless'], env)
            self.assertEqual(spawn.call_args_list[0].args[0], ['npx', '-y', 'playwright', 'install', '--with-deps', 'chrome'])
            self.assertIn('--headless=new', spawn.call_args_list[1].args[0])
            self.assertIn('--window-size=1440,900', spawn.call_args_list[1].args[0])
            self.assertNotIn('--start-maximized', spawn.call_args_list[1].args[0])
            self.assertEqual(env['PLAYWRIGHT_MCP_CDP_ENDPOINT'], 'http://127.0.0.1:9222')
