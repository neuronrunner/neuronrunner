from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import override_settings
from rest_framework.test import APITestCase

from authentication.models import OTP

User = get_user_model()


def _mock_turnstile_response(payload: dict, status_code: int = 200):
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = payload
    resp.raise_for_status.return_value = None
    return resp


@override_settings(
    TURNSTILE_SECRET='test_turnstile_secret',
    TURNSTILE_HOSTNAMES=['localhost', '127.0.0.1'],
)
class TurnstileAndEmailHygieneTests(APITestCase):
    def setUp(self):
        cache.clear()

    def test_send_otp_requires_turnstile_token(self):
        res = self.client.post('/auth/send-otp/', {'email': 'alice@example.com'}, format='json')
        self.assertEqual(res.status_code, 403)

    @patch('authentication.services.turnstile.requests.post')
    def test_send_otp_rejects_wrong_action_or_hostname(self, mock_post):
        mock_post.return_value = _mock_turnstile_response(
            {'success': True, 'action': 'login', 'hostname': 'localhost'}
        )
        res = self.client.post(
            '/auth/send-otp/',
            {'email': 'alice@example.com', 'cf_turnstile_response': 'tok_123'},
            format='json',
        )
        self.assertEqual(res.status_code, 403)

        mock_post.return_value = _mock_turnstile_response(
            {'success': True, 'action': 'send_otp', 'hostname': 'evil.example.com'}
        )
        cache.clear()
        res2 = self.client.post(
            '/auth/send-otp/',
            {'email': 'alice@example.com', 'cf_turnstile_response': 'tok_123'},
            format='json',
        )
        self.assertEqual(res2.status_code, 403)

    @patch('authentication.services.turnstile.requests.post')
    def test_send_otp_blocks_disposable_and_plus_alias(self, mock_post):
        mock_post.return_value = _mock_turnstile_response(
            {'success': True, 'action': 'send_otp', 'hostname': 'localhost'}
        )

        res_disp = self.client.post(
            '/auth/send-otp/',
            {'email': 'bot@mailinator.com', 'cf_turnstile_response': 'tok_123'},
            format='json',
        )
        self.assertEqual(res_disp.status_code, 400)
        self.assertIn('Disposable', res_disp.data['error'])

        res_alias = self.client.post(
            '/auth/send-otp/',
            {'email': 'alice+1@gmail.com', 'cf_turnstile_response': 'tok_123'},
            format='json',
        )
        self.assertEqual(res_alias.status_code, 400)
        self.assertIn('aliases', res_alias.data['error'])

    @patch('authentication.services.turnstile.requests.post')
    def test_send_otp_blocks_gmail_dot_variant_duplicate(self, mock_post):
        User.objects.create_user(
            username='alice',
            email='alice@gmail.com',
            password='Password123!',
        )
        mock_post.return_value = _mock_turnstile_response(
            {'success': True, 'action': 'send_otp', 'hostname': 'localhost'}
        )

        res = self.client.post(
            '/auth/send-otp/',
            {'email': 'a.l.i.c.e@gmail.com', 'cf_turnstile_response': 'tok_123'},
            format='json',
        )
        self.assertEqual(res.status_code, 400)
        self.assertIn('already registered', res.data['error'])

    @patch('authentication.services.turnstile.requests.post')
    def test_send_otp_and_register_succeed_with_valid_turnstile(self, mock_post):
        mock_post.return_value = _mock_turnstile_response(
            {'success': True, 'action': 'send_otp', 'hostname': 'localhost'}
        )
        send_res = self.client.post(
            '/auth/send-otp/',
            {'email': 'newuser@example.com', 'cf_turnstile_response': 'tok_step1'},
            format='json',
        )
        self.assertEqual(send_res.status_code, 200)
        otp_obj = OTP.objects.get(email='newuser@example.com')

        mock_post.return_value = _mock_turnstile_response(
            {'success': True, 'action': 'signup', 'hostname': 'localhost'}
        )
        reg_res = self.client.post(
            '/auth/register/',
            {
                'username': 'newuser',
                'email': 'newuser@example.com',
                'password': 'StrongPassword123!',
                'otp': otp_obj.otp,
                'cf_turnstile_response': 'tok_step2',
            },
            format='json',
        )
        self.assertEqual(reg_res.status_code, 201)
        self.assertTrue(User.objects.filter(username='newuser').exists())

    @override_settings(MAX_SIGNUPS_PER_IP_PER_DAY=2)
    @patch('authentication.services.turnstile.requests.post')
    def test_ip_daily_signup_limit_blocks_excess_registrations(self, mock_post):
        for idx in range(2):
            email = f'user{idx}@example.com'
            mock_post.return_value = _mock_turnstile_response(
                {'success': True, 'action': 'send_otp', 'hostname': 'localhost'}
            )
            r1 = self.client.post(
                '/auth/send-otp/',
                {'email': email, 'cf_turnstile_response': f'tok_s_{idx}'},
                format='json',
                REMOTE_ADDR='203.0.113.10',
            )
            self.assertEqual(r1.status_code, 200)
            otp_obj = OTP.objects.get(email=email)

            mock_post.return_value = _mock_turnstile_response(
                {'success': True, 'action': 'signup', 'hostname': 'localhost'}
            )
            r2 = self.client.post(
                '/auth/register/',
                {
                    'username': f'ipuser{idx}',
                    'email': email,
                    'password': 'StrongPassword123!',
                    'otp': otp_obj.otp,
                    'cf_turnstile_response': f'tok_r_{idx}',
                },
                format='json',
                REMOTE_ADDR='203.0.113.10',
            )
            self.assertEqual(r2.status_code, 201)

        mock_post.return_value = _mock_turnstile_response(
            {'success': True, 'action': 'send_otp', 'hostname': 'localhost'}
        )
        r_blocked = self.client.post(
            '/auth/send-otp/',
            {'email': 'user2@example.com', 'cf_turnstile_response': 'tok_blocked'},
            format='json',
            REMOTE_ADDR='203.0.113.10',
        )
        self.assertEqual(r_blocked.status_code, 429)
        self.assertIn('IP address', r_blocked.data['error'])

    @override_settings(MAX_SIGNUPS_PER_IP_PER_DAY=1)
    @patch('authentication.services.turnstile.requests.post')
    def test_cloudflare_connecting_ip_takes_precedence(self, mock_post):
        mock_post.return_value = _mock_turnstile_response(
            {'success': True, 'action': 'send_otp', 'hostname': 'localhost'}
        )
        r1 = self.client.post(
            '/auth/send-otp/',
            {'email': 'cf1@example.com', 'cf_turnstile_response': 'tok_cf1'},
            format='json',
            HTTP_CF_CONNECTING_IP='198.51.100.77',
            HTTP_X_FORWARDED_FOR='1.2.3.4',
            REMOTE_ADDR='10.0.0.1',
        )
        self.assertEqual(r1.status_code, 200)
        otp_obj = OTP.objects.get(email='cf1@example.com')

        mock_post.return_value = _mock_turnstile_response(
            {'success': True, 'action': 'signup', 'hostname': 'localhost'}
        )
        r2 = self.client.post(
            '/auth/register/',
            {
                'username': 'cfuser1',
                'email': 'cf1@example.com',
                'password': 'StrongPassword123!',
                'otp': otp_obj.otp,
                'cf_turnstile_response': 'tok_cf2',
            },
            format='json',
            HTTP_CF_CONNECTING_IP='198.51.100.77',
            HTTP_X_FORWARDED_FOR='5.6.7.8',
            REMOTE_ADDR='10.0.0.2',
        )
        self.assertEqual(r2.status_code, 201)

        mock_post.return_value = _mock_turnstile_response(
            {'success': True, 'action': 'send_otp', 'hostname': 'localhost'}
        )
        # Same CF-Connecting-IP even with a spoofed X-Forwarded-For must be blocked
        r_blocked = self.client.post(
            '/auth/send-otp/',
            {'email': 'cf2@example.com', 'cf_turnstile_response': 'tok_cf3'},
            format='json',
            HTTP_CF_CONNECTING_IP='198.51.100.77',
            HTTP_X_FORWARDED_FOR='9.9.9.9',
            REMOTE_ADDR='10.0.0.3',
        )
        self.assertEqual(r_blocked.status_code, 429)
