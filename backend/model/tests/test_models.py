"""
Unit tests for the model app.
"""
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from model.models import LLMConfig, Model, ModelDownloadTask

User = get_user_model()


@override_settings(DEFAULT_FILE_STORAGE='django.core.files.storage.InMemoryStorage')
class ModelModelTests(TestCase):
    """Test Model creation and configuration relations."""

    def setUp(self):
        self.user = User.objects.create_user(
            username='testuser',
            password='testpass123',
            email='test@example.com',
        )

    def test_create_vllm_model_with_llm_config(self):
        model = Model.objects.create(
            name='meta-llama-3-8b',
            model_type='text',
            author=self.user,
            runner=Model.RUNNER_VLLM,
            source=Model.SOURCE_HUGGINGFACE,
            storage_path='hf/meta-llama/Meta-Llama-3-8B-Instruct',
            is_reasoning=False,
            is_public=True,
        )
        LLMConfig.objects.create(
            model=model,
            max_tokens=4096,
            default_temperature=0.7,
        )

        self.assertEqual(model.runner, 'vllm')
        self.assertEqual(model.llm_config.max_tokens, 4096)

    def test_model_download_task_relation(self):
        model = Model.objects.create(
            name='downloading-model',
            model_type='text',
            author=self.user,
            runner=Model.RUNNER_VLLM,
            status=Model.STATUS_DOWNLOADING,
        )
        ModelDownloadTask.objects.create(
            model=model,
            repo_id='meta-llama/Meta-Llama-3-8B',
            initiated_by=self.user,
            status=ModelDownloadTask.STATUS_QUEUED,
        )

        self.assertEqual(model.download_tasks.count(), 1)
        self.assertEqual(model.download_tasks.first().repo_id, 'meta-llama/Meta-Llama-3-8B')


@override_settings(DEFAULT_FILE_STORAGE='django.core.files.storage.InMemoryStorage')
class ModelAPITests(TestCase):
    """Test model endpoints."""

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            username='testuser',
            password='testpass123',
            email='test@example.com',
        )
        self.client.force_authenticate(user=self.user)
        self.model = Model.objects.create(
            name='test-llm',
            model_type='text',
            author=self.user,
            runner=Model.RUNNER_VLLM,
            status=Model.STATUS_ACTIVE,
            is_public=True,
        )

    def test_list_models(self):
        response = self.client.get('/models/')
        self.assertEqual(response.status_code, 200)

    def test_retrieve_model(self):
        response = self.client.get(f'/models/{self.model.name}/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['name'], 'test-llm')

    def test_legacy_tags_compatibility_endpoint(self):
        response = self.client.get(f'/models/{self.model.name}/tags/')
        self.assertEqual(response.status_code, 200)
        self.assertIsInstance(response.data, list)
        self.assertEqual(len(response.data), 1)
        self.assertEqual(response.data[0]['name'], 'test-llm')


class ModelCatalogOrderingAndOssAdminTests(TestCase):
    def setUp(self):
        self.staff_user = User.objects.create_user(
            username="adminuser",
            email="admin@example.com",
            password="adminpassword123",
            is_staff=True,
        )
        self.client = APIClient()

    def test_admin_endpoints_not_exposed_in_oss(self):
        self.client.force_authenticate(user=self.staff_user)
        for path in (
            "/models/admin/overview/",
            "/models/admin/models/",
            "/models/admin/models/create-llm/",
            "/models/admin/models/llms/test/",
            "/models/admin/users/",
        ):
            res = self.client.get(path)
            self.assertEqual(res.status_code, 404, f"{path} should not be mounted in OSS")

    def test_free_tier_models_listed_first(self):
        paid_model = Model.objects.create(
            name="paid-newer-model",
            display_name="Paid Newer Model",
            description="Paid",
            model_type="text",
            runner=Model.RUNNER_TENSORRT_LLM,
            source=Model.SOURCE_EXTERNAL,
            status=Model.STATUS_ACTIVE,
            is_free_tier=False,
            is_public=True,
            author=self.staff_user,
        )
        free_model = Model.objects.create(
            name="free-older-model",
            display_name="Free Older Model",
            description="Free",
            model_type="text",
            runner=Model.RUNNER_TENSORRT_LLM,
            source=Model.SOURCE_EXTERNAL,
            status=Model.STATUS_ACTIVE,
            is_free_tier=True,
            is_public=True,
            author=self.staff_user,
        )
        self.assertIsNotNone(paid_model.pk)
        self.assertIsNotNone(free_model.pk)

        res = self.client.get("/models/?ordering=-runs")
        self.assertEqual(res.status_code, 200)
        names = [item["name"] for item in res.json().get("results", [])]
        self.assertLess(names.index("free-older-model"), names.index("paid-newer-model"))


