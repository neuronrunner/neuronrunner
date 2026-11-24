import json
from io import StringIO
from importlib import import_module
from types import SimpleNamespace
from unittest import skipUnless
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.apps import apps
from django.db import connection
from django.core.management import call_command
from django.test import SimpleTestCase, TestCase, override_settings
from rest_framework.test import APIClient

from chat.builtin_tools import execute_builtin_tool
from chat.models import AgentNote, Conversation, Memory, Message, Tool
from chat.services.chat_service import ChatService
from chat.services.memory_extraction import extract_memories
from chat.services.memory_service import MemoryService, NoteService, StoreError, refresh_embedding
from chat.services.search_text import _stemmers, fold, keys, matched_terms, search_terms, stopwords, tokens
from chat.services.utils import embedding_model_name, get_vector_cached
from sandbox.models import Sandbox, WorkspaceMembership
from sandbox.services.sandbox_service import SandboxBootstrapService


class SearchTextTests(SimpleTestCase):
    def setUp(self):
        self.clear_caches()
        self.addCleanup(self.clear_caches)

    def clear_caches(self):
        stopwords.cache_clear()
        _stemmers.cache_clear()
        keys.cache_clear()

    def test_turkish_case_accents_and_decomposed_letters_are_folded(self):
        self.assertEqual(fold('İIıi ÇĞÖŞÜ ÂÎÛ'), 'iiii cgosu aiu')
        self.assertEqual(fold('I\u0307 C\u0327 G\u0306 O\u0308 S\u0327 U\u0308'), 'i c g o s u')
        self.assertEqual(search_terms('İŞLEM işlem ISLEM'), ['islem'])
        self.assertEqual(fold('e\u0301\u0308'), 'e')

    def test_both_languages_remove_stopwords_and_filler(self):
        self.assertEqual(search_terms('THE and with please hello teşekkürler İÇİN bir peki tamam'), [])
        self.assertEqual(search_terms('Please show dokümantasyonu and deployed'), ['dokumantasyonu', 'deployed'])

    def test_stopword_corpus_outage_uses_builtin_lists_without_downloads(self):
        corpus = SimpleNamespace(fileids=Mock(side_effect=LookupError('corpus missing')))
        with patch('nltk.corpus.stopwords', corpus), patch('nltk.download') as download:
            self.assertEqual(search_terms('the için lütfen deployed dokümantasyonu'), ['deployed', 'dokumantasyonu'])
            self.assertEqual(matched_terms('Deploy dokümantasyon', search_terms('deployed dokümantasyonu')), 2)
            download.assert_not_called()

    def test_missing_nltk_keeps_turkish_search_available(self):
        with patch.dict('sys.modules', {'nltk': None, 'nltk.corpus': None, 'nltk.stem.snowball': None}):
            self.assertEqual(search_terms('the için dokümantasyonu'), ['dokumantasyonu'])
            self.assertEqual(matched_terms('Dokümantasyon', search_terms('dokümantasyonu')), 1)

    def test_inflections_match_in_both_directions(self):
        for base, inflected in [('dokümantasyon', 'dokümantasyonu'), ('kullanıcı', 'kullanıcının'),
                                ('deploy', 'deployed'), ('study', 'studies')]:
            for content, query in [(base, inflected), (inflected, base)]:
                with self.subTest(content=content, query=query):
                    self.assertEqual(matched_terms(content, search_terms(query)), 1)

    def test_substrings_and_unrelated_candidate_prefixes_do_not_match(self):
        self.assertEqual(matched_terms('The user starts work early', search_terms('the art')), 0)
        self.assertEqual(matched_terms('Deplane safely', search_terms('deployed')), 0)

    def test_terms_are_distinct_and_bounded(self):
        self.assertEqual(search_terms('Redis redis Docker Modal', limit=2), ['redis', 'docker'])
        self.assertEqual(search_terms('Redis Docker', limit=0), [])
        self.assertEqual(len(search_terms(' '.join(f'term{i}' for i in range(20)))), 12)

    def test_unicode_literal_fallback_accepts_scripts_without_stemmers(self):
        for word in ['डेटाबेस', 'বাংলা', 'தமிழ்', 'తెలుగు', 'ಕನ್ನಡ', 'മലയാളം', 'සිංහල',
                     'מסד', 'پایگاه', 'βάση', 'ქართული', 'հիշողություն', 'መረጃ',
                     'ຂໍ້ມູນ', 'ទិន្នន័យ', 'မှတ်ဉာဏ်', '数据库', 'データベース', '데이터', 'ฐานข้อมูล']:
            with self.subTest(word=word):
                terms = search_terms(word)
                self.assertTrue(terms)
                self.assertGreater(matched_terms(word, terms), 0)

    def test_non_latin_short_words_and_combining_marks_are_preserved(self):
        self.assertEqual(tokens('डेटाबेस தமிழ் বাংলা ಕನ್ನಡ తెలుగు සිංහල'),
                         ['डेटाबेस', 'தமிழ்', 'বাংলা', 'ಕನ್ನಡ', 'తెలుగు', 'සිංහල'])
        for word in ['猫', '库', 'אב', 'бд', '책']:
            with self.subTest(word=word):
                self.assertEqual(search_terms(word), [word])
        self.assertEqual(search_terms('a ab 1 42'), [])

    def test_available_nltk_stopwords_cover_multiple_language_families(self):
        if len(stopwords()) <= 1:
            self.skipTest("NLTK stopwords corpus is not installed")
        for sentence, expected in [
            ('el la y con para documentación', ['documentacion']),
            ('der die und mit für Dokumentation', ['dokumentation']),
            ('le la et avec pour documentation', ['documentation']),
            ('и в на для документация', ['документация']),
            ('في من على إلى قاعدة', ['قاعدة']),
        ]:
            with self.subTest(sentence=sentence):
                self.assertEqual(search_terms(sentence), expected)

    def test_stopword_detection_keeps_english_words_that_are_foreign_function_words(self):
        self.assertEqual(search_terms('the processes die'), ['processes', 'die'])

    def test_new_corpus_languages_are_discovered_without_a_whitelist(self):
        corpus = SimpleNamespace(fileids=Mock(return_value=['new-language']),
                                 words=Mock(return_value=['functiona', 'functionb']))
        with patch('nltk.corpus.stopwords', corpus):
            self.assertEqual(search_terms('functiona functionb knowledge'), ['knowledge'])
            corpus.words.assert_called_once_with('new-language')

    def test_non_english_stemmers_match_inflections_in_both_directions(self):
        for base, inflected in [('déploiement', 'déploiements'), ('Haus', 'Häuser'),
                                ('conexión', 'conexiones'), ('conexão', 'conexões'),
                                ('macchina', 'macchine'), ('база', 'базы'), ('كتاب', 'الكتاب')]:
            for content, query in [(base, inflected), (inflected, base)]:
                with self.subTest(content=content, query=query):
                    self.assertEqual(matched_terms(content, search_terms(query)), 1)

    def test_unsegmented_terms_match_inside_longer_runs(self):
        for query, content in [('数据库', '项目使用数据库管理文档'),
                               ('データベース', 'プロジェクトのデータベース設定'),
                               ('ฐานข้อมูล', 'ระบบฐานข้อมูลโครงการ')]:
            with self.subTest(query=query):
                self.assertIn(query, search_terms(query))
                self.assertGreater(matched_terms(content, search_terms(query)), 0)
                self.assertEqual(matched_terms('Unrelated Docker tooling', search_terms(query)), 0)

    def test_corpus_outage_keeps_literal_search_for_other_scripts(self):
        with patch.dict('sys.modules', {'nltk': None, 'nltk.corpus': None, 'nltk.stem.snowball': None}):
            for word in ['डेटाबेस', 'מסד', 'база', 'كتاب', '数据库', 'データベース', 'ฐานข้อมูล']:
                with self.subTest(word=word):
                    self.assertGreater(matched_terms(word, search_terms(word)), 0)


EXTRACTION_TARGET = {'api_key': 'sk-workspace', 'base_url': 'https://openrouter.ai/api/v1', 'model': 'review-extraction'}


@override_settings(MEMORY_EMBEDDING_MODEL='openrouter:review-embedding-v1')
class MemoryLifecycleTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username='memory-review', email='memory-review@example.com')
        self.other = get_user_model().objects.create_user(username='memory-other', email='memory-other@example.com')
        self.workspace = SandboxBootstrapService.ensure_personal_workspace(self.user)
        self.project = Sandbox.objects.create(user=self.user, workspace=self.workspace, slug='memory-project')
        self.other_project = Sandbox.objects.create(user=self.user, workspace=self.workspace, slug='other-project')
        self.conversation = Conversation.objects.create(user=self.user, workspace=self.workspace)
        self.project.conversations.add(self.conversation)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.embedding = patch('chat.services.memory_service.get_vector_cached', return_value=[1.0, 0.0, 0.0])
        self.embed = self.embedding.start()
        self.addCleanup(self.embedding.stop)

    def tool(self, name, data=None, conversation=None):
        return json.loads(execute_builtin_tool(self.user, name, data or {}, conversation=conversation))

    def test_rest_and_tool_add_generate_the_same_embedding_metadata(self):
        response = self.client.post('/tools/memory/add/', {'content': 'I prefer Turkish', 'category': 'preference'})
        self.assertEqual(response.status_code, 201)
        memory = Memory.objects.get(pk=response.data['uuid'])
        self.assertEqual(list(memory.vector), [1, 0, 0])
        self.assertEqual(memory.embedding_model, embedding_model_name())
        note = self.client.post('/tools/note/add/', {'content': 'Use pytest', 'sandbox_uuid': str(self.project.pk)})
        self.assertEqual(note.status_code, 201)
        self.assertIsNotNone(AgentNote.objects.get(pk=note.data['uuid']).vector)
        duplicate = self.tool('memory_add', {'content': 'i prefer turkish'})
        self.assertEqual(duplicate['uuid'], str(memory.pk))
        self.assertEqual(Memory.objects.count(), 1)

    def test_replace_refreshes_embedding_for_both_stores_and_both_adapters(self):
        memory, _ = MemoryService(self.user).create({'content': 'Old preference'})
        note, _ = NoteService(self.user, sandbox_uuid=self.project.pk).create({'content': 'Old note'})
        self.embed.return_value = [0, 1, 0]
        updated = self.tool('memory_replace', {'uuid': str(memory.pk), 'new_content': 'New preference'})
        self.assertEqual(updated['status'], 'ok')
        response = self.client.post('/tools/note/replace/', {'uuid': str(note.pk), 'new_content': 'New note', 'sandbox_uuid': str(self.project.pk)})
        self.assertEqual(response.status_code, 200)
        memory.refresh_from_db()
        note.refresh_from_db()
        self.assertEqual(list(memory.vector), [0, 1, 0])
        self.assertEqual(list(note.vector), [0, 1, 0])

    def test_embedding_outage_clears_stale_vector_and_keeps_record_searchable(self):
        memory, _ = MemoryService(self.user).create({'content': 'Old preference'})
        self.embed.side_effect = RuntimeError('unavailable')
        response = self.client.patch(f'/memories/{memory.pk}/update/', {'content': 'New Turkish preference'}, format='json')
        self.assertEqual(response.status_code, 200)
        memory.refresh_from_db()
        self.assertIsNone(memory.vector)
        self.assertEqual(memory.embedding_model, '')
        self.assertEqual(self.tool('memory_search', {'query': 'Turkish'})['count'], 1)

    def test_stale_embedding_worker_cannot_overwrite_newer_content(self):
        memory, _ = MemoryService(self.user).create({'content': 'Initial content'})
        Memory.objects.filter(pk=memory.pk).update(content='New content', vector=None, embedding_model='')
        refresh_embedding(memory)
        memory.refresh_from_db()
        self.assertIsNone(memory.vector)

    def test_memory_opt_out_blocks_all_tools_but_allows_user_management_and_notes(self):
        memory, _ = MemoryService(self.user).create({'content': 'A preference'})
        get_user_model().objects.filter(pk=self.user.pk).update(memory_enabled=False)
        cases = {'add': {'content': 'New fact'}, 'replace': {'uuid': str(memory.pk), 'new_content': 'Changed'},
                 'remove': {'uuid': str(memory.pk)}, 'list': {}, 'search': {'query': 'preference'}}
        for action, data in cases.items():
            with self.subTest(action=action):
                self.assertIn('error', self.tool('memory_' + action, data))
        self.assertEqual(self.client.post('/tools/memory/add/', {'content': 'Another fact'}).status_code, 403)
        self.assertEqual(self.client.get('/memories/').status_code, 200)
        self.assertEqual(self.client.patch(f'/memories/{memory.pk}/update/', {'content': 'Manual edit'}, format='json').status_code, 200)
        self.assertEqual(self.tool('note_add', {'content': 'Project note'}, self.conversation)['status'], 'ok')
        self.assertEqual(self.client.delete(f'/memories/{memory.pk}/').status_code, 200)

    def test_project_scope_is_identical_for_search_list_update_and_delete(self):
        visible, _ = NoteService(self.user, sandbox_uuid=self.project.pk).create({'content': 'Database PostgreSQL'})
        hidden, _ = NoteService(self.user, sandbox_uuid=self.other_project.pk).create({'content': 'Database SQLite'})
        for name, data in [('note_search', {'query': 'Database'}), ('note_list', {})]:
            result = self.tool(name, data, self.conversation)
            self.assertEqual([n['uuid'] for n in result['notes']], [str(visible.pk)])
        self.assertIn('error', self.tool('note_remove', {'uuid': str(hidden.pk)}, self.conversation))
        self.assertIn('error', self.tool('note_replace', {'uuid': str(hidden.pk), 'new_content': 'Changed'}, self.conversation))
        self.assertTrue(AgentNote.objects.filter(pk=hidden.pk).exists())

    def test_forged_project_cannot_override_conversation_or_create_unscoped_note(self):
        result = self.tool('note_add', {'content': 'Scoped note', 'sandbox_uuid': str(self.other_project.pk)}, self.conversation)
        self.assertEqual(AgentNote.objects.get(pk=result['uuid']).sandbox_id, self.project.pk)
        bad = self.client.post('/tools/note/add/', {'content': 'Invalid scope', 'sandbox_uuid': 'not-a-uuid'})
        self.assertEqual(bad.status_code, 400)
        self.assertFalse(AgentNote.objects.filter(content='Invalid scope').exists())
        inaccessible = Sandbox.objects.create(user=self.other, slug='private-project')
        bad = self.client.post('/tools/note/add/', {'content': 'Forbidden scope', 'sandbox_uuid': str(inaccessible.pk)})
        self.assertEqual(bad.status_code, 404)

    def test_shared_project_notes_keep_scope_and_are_visible_to_members(self):
        WorkspaceMembership.objects.create(user=self.other, workspace=self.workspace, role='member')
        result = json.loads(execute_builtin_tool(self.other, 'note_add', {'content': 'Member note'}, conversation=self.conversation))
        note = AgentNote.objects.get(pk=result['uuid'])
        self.assertEqual(note.sandbox_id, self.project.pk)
        self.assertEqual(note.workspace_id, self.workspace.pk)
        self.assertEqual(self.tool('note_list', {}, self.conversation)['notes'][0]['uuid'], str(note.pk))
        WorkspaceMembership.objects.filter(user=self.other, workspace=self.workspace).delete()
        with self.assertRaises(StoreError):
            NoteService(self.other, sandbox_uuid=self.project.pk)

    def test_team_conversation_cannot_read_or_write_personal_memory(self):
        MemoryService(self.user).create({'content': 'Private personal preference'})
        WorkspaceMembership.objects.create(user=self.other, workspace=self.workspace, role='member')
        self.assertIn('error', self.tool('memory_search', {'query': 'Private'}, self.conversation))
        self.assertIn('error', self.tool('memory_add', {'content': 'Team fact'}, self.conversation))

    def test_workspace_note_scope_does_not_include_other_workspaces_or_projects(self):
        workspace_note, _ = NoteService(self.user, workspace_uuid=self.workspace.pk).create({'content': 'Workspace rule'})
        NoteService(self.user, sandbox_uuid=self.project.pk).create({'content': 'Project rule'})
        other_workspace = SandboxBootstrapService.ensure_personal_workspace(self.other)
        NoteService(self.other, workspace_uuid=other_workspace.pk).create({'content': 'Other rule'})
        response = self.client.get('/tools/note/list/', {'workspace_uuid': str(self.workspace.pk)})
        self.assertEqual([n['uuid'] for n in response.data['notes']], [str(workspace_note.pk)])

    def test_unscoped_calls_use_private_workspace_and_do_not_default_to_team(self):
        result = self.tool('note_add', {'content': 'Private workspace rule'})
        self.assertEqual(AgentNote.objects.get(pk=result['uuid']).workspace_id, self.workspace.pk)
        WorkspaceMembership.objects.create(user=self.other, workspace=self.workspace)
        self.assertIn('error', self.tool('note_add', {'content': 'Must choose scope'}))
        self.assertFalse(AgentNote.objects.filter(content='Must choose scope').exists())

    def test_revocation_is_checked_again_on_an_existing_note_service(self):
        WorkspaceMembership.objects.create(user=self.other, workspace=self.workspace)
        service = NoteService(self.other, sandbox_uuid=self.project.pk)
        WorkspaceMembership.objects.filter(user=self.other, workspace=self.workspace).delete()
        with self.assertRaises(StoreError):
            service.create({'content': 'Revoked access'})

    def test_ambiguous_old_text_requires_uuid_and_does_not_mutate(self):
        first, _ = MemoryService(self.user).create({'content': 'Python frontend tooling'})
        second, _ = MemoryService(self.user).create({'content': 'Python backend tooling'})
        result = self.tool('memory_remove', {'old_text': 'Python'})
        self.assertIn('error', result)
        self.assertEqual(len(result['matches']), 2)
        self.assertEqual(Memory.objects.count(), 2)
        response = self.client.post('/tools/memory/replace/', {'old_text': 'Python', 'new_content': 'Changed'})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.tool('memory_remove', {'uuid': str(first.pk)})['removed_uuid'], str(first.pk))
        self.assertTrue(Memory.objects.filter(pk=second.pk).exists())

    def test_exact_match_is_preferred_and_duplicate_update_is_conflict(self):
        first, _ = MemoryService(self.user).create({'content': 'Python'})
        second, _ = MemoryService(self.user).create({'content': 'Python backend'})
        self.assertEqual(MemoryService(self.user).find({'old_text': 'Python'}).pk, first.pk)
        response = self.client.patch(f'/memories/{first.pk}/update/', {'content': second.content}, format='json')
        self.assertEqual(response.status_code, 409)

    def test_invalid_inputs_are_400_and_workspace_category_is_accepted(self):
        for data in [{'content': []}, {'content': 'Fact', 'importance_score': 'invalid'}, {'content': 'Fact', 'importance_score': 11}, {'content': 'Fact', 'label': 'x'*101}]:
            self.assertEqual(self.client.post('/tools/memory/add/', data, format='json').status_code, 400)
        memory, _ = MemoryService(self.user).create({'content': 'Workspace preference'})
        response = self.client.patch(f'/memories/{memory.pk}/update/', {'category': 'workspace', 'label': None}, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['category'], 'workspace')
        self.assertIsNone(response.data['label'])

    def test_uuid_access_never_reaches_another_users_memory(self):
        hidden, _ = MemoryService(self.other).create({'content': 'Another user'})
        self.assertEqual(self.client.delete(f'/memories/{hidden.pk}/').status_code, 404)

    def test_search_ranks_relevance_importance_recency_and_marks_access(self):
        low, _ = MemoryService(self.user).create({'content': 'Turkish preference low', 'importance_score': 1})
        high, _ = MemoryService(self.user).create({'content': 'Turkish preference high', 'importance_score': 10})
        results = MemoryService(self.user).search({'query': 'Turkish', 'limit': 1})
        self.assertEqual([r.pk for r in results], [high.pk])
        high.refresh_from_db()
        low.refresh_from_db()
        self.assertIsNotNone(high.last_accessed_at)
        self.assertIsNone(low.last_accessed_at)

    def test_runtime_database_schema_is_normalized(self):
        tool = Tool(name='memory_replace', parameters_schema={'properties': {'category': {'enum': ['project']}}, 'required': ['old_text', 'new_content']})
        parameters = tool.to_function_schema()['function']['parameters']
        self.assertIn('workspace', parameters['properties']['category']['enum'])
        self.assertIn('uuid', parameters['properties'])
        self.assertNotIn('old_text', parameters['required'])

    def service(self, content):
        service = ChatService.__new__(ChatService)
        service.conversation = self.conversation
        service.current_request = SimpleNamespace(user=self.user, parent=None)
        service.user_msg = SimpleNamespace(content=content)
        return service

    def test_saved_context_is_relevant_bounded_and_skips_greetings(self):
        MemoryService(self.user).create({'content': 'Turkish preferred language'})
        NoteService(self.user, sandbox_uuid=self.project.pk).create({'content': 'Turkish documentation convention'})
        context = self.service('Turkish documentation')._saved_context()
        self.assertIn('preferred language', context)
        self.assertIn('documentation convention', context)
        self.assertLess(len(context), 4200)
        self.assertEqual(self.service('merhaba')._saved_context(), '')
        get_user_model().objects.filter(pk=self.user.pk).update(memory_enabled=False)
        context = self.service('Turkish documentation')._saved_context()
        self.assertNotIn('preferred language', context)
        self.assertIn('documentation convention', context)

    def test_guide_and_schemas_hide_memory_tools_when_disabled(self):
        tool, _ = Tool.objects.update_or_create(name='memory_search', defaults={'description': 'Memory', 'parameters_schema': {}})
        service = self.service('Turkish')
        service.tools = [tool.to_function_schema()]
        service._get_mcp_tools = lambda: []
        get_user_model().objects.filter(pk=self.user.pk).update(memory_enabled=False)
        self.assertNotIn('memory_search', [t['function']['name'] for t in service._merge_mcp_tools()])
        service.system_prompt = ''
        service.attachments_context = ''
        service._model_catalog_guide = lambda: ''
        service._trim_messages_to_context = lambda messages: messages
        guide = service._build_messages()[0]['content']
        self.assertNotIn('memory_search(', guide)
        self.assertNotIn('memory_add', guide)
        self.assertIn('note_search(', guide)

    def test_workspace_notes_are_recalled_alongside_project_notes(self):
        NoteService(self.user, workspace_uuid=self.workspace.pk).create({'content': 'Turkish workspace docs'})
        NoteService(self.user, sandbox_uuid=self.project.pk).create({'content': 'Turkish project docs'})
        context = self.service('Turkish docs')._saved_context()
        self.assertIn('workspace docs', context)
        self.assertIn('project docs', context)

    def test_lexical_search_ignores_stopwords_and_substrings_and_ranks_coverage(self):
        MemoryService(self.user).create({'content': 'The user starts work early', 'importance_score': 10})
        partial, _ = MemoryService(self.user).create({'content': 'Deploys with Docker', 'importance_score': 10})
        full, _ = MemoryService(self.user).create({'content': 'Deploys Docker images to Kubernetes', 'importance_score': 1})
        # "the" is a stopword and "art" must not match inside "starts".
        self.assertEqual(MemoryService(self.user).search({'query': 'the art'}, semantic=False), [])
        results = MemoryService(self.user).search({'query': 'docker kubernetes deploy'}, semantic=False)
        self.assertEqual([r.pk for r in results], [full.pk, partial.pk])
        strict = MemoryService(self.user).search({'query': 'docker kubernetes deploy'}, semantic=False, min_matches=3)
        self.assertEqual([r.pk for r in strict], [full.pk])

    def test_saved_context_skips_filler_and_does_not_mark_access(self):
        memory, _ = MemoryService(self.user).create({'content': 'Prefers Turkish answers'})
        self.assertEqual(self.service('teşekkürler, tamam!')._saved_context(), '')
        self.assertIn('Turkish answers', self.service('Turkish please')._saved_context())
        memory.refresh_from_db()
        self.assertIsNone(memory.last_accessed_at)

    def test_lexical_search_finds_turkish_suffixes_and_spelling_variants_in_both_stores(self):
        for store in [MemoryService(self.user), NoteService(self.user, sandbox_uuid=self.project.pk)]:
            record, _ = store.create({'content': 'Dokümantasyon kullanıcı rehberi İŞLEM', 'importance_score': 5})
            self.embed.reset_mock()
            for query in ['dokümantasyonu', 'DOKUMANTASYONU', 'kullanıcının', 'KULLANICININ', 'islem']:
                with self.subTest(store=type(store).__name__, query=query):
                    results = store.search({'query': query}, semantic=False, touch=False)
                    self.assertEqual([r.pk for r in results], [record.pk])
            self.embed.assert_not_called()

    def test_lexical_search_finds_english_inflections_in_both_directions(self):
        for store in [MemoryService(self.user), NoteService(self.user, sandbox_uuid=self.project.pk)]:
            for content, query in [('Deploy', 'deployed'), ('Deployed', 'deploy'),
                                   ('Study', 'studies'), ('Studies', 'study')]:
                with self.subTest(store=type(store).__name__, content=content, query=query):
                    record, _ = store.create({'content': content})
                    results = store.search({'query': query}, semantic=False)
                    self.assertIn(record.pk, [r.pk for r in results])

    def test_lexical_search_verifies_candidates_and_ignores_stopword_only_queries(self):
        MemoryService(self.user).create({'content': 'Deplane safely', 'importance_score': 10})
        record, _ = MemoryService(self.user).create({'content': 'Deploy the service'})
        MemoryService(self.user).create({'content': 'the and with için bir lütfen'})
        self.assertEqual([r.pk for r in MemoryService(self.user).search({'query': 'deployed'}, semantic=False)], [record.pk])
        self.assertEqual(MemoryService(self.user).search({'query': 'the and with'}, semantic=False), [])
        self.assertEqual(MemoryService(self.user).search({'query': 'için bir lütfen'}, semantic=False), [])

    def test_multilingual_recall_preserves_scope_threshold_and_no_access_updates(self):
        memory, _ = MemoryService(self.user).create({'content': 'Dokümantasyon deploy rehberi'})
        note, _ = NoteService(self.user, sandbox_uuid=self.project.pk).create({'content': 'Dokümantasyon deployment adımları'})
        MemoryService(self.user).create({'content': 'Redis unrelated preference', 'importance_score': 10})
        NoteService(self.user, sandbox_uuid=self.other_project.pk).create({'content': 'Dokümantasyon deploy hidden project'})
        self.embed.reset_mock()
        context = self.service('Lütfen dokümantasyonu deployed Redis Kubernetes göster')._saved_context()
        self.assertIn('Dokümantasyon deploy rehberi', context)
        self.assertIn('Dokümantasyon deployment adımları', context)
        self.assertNotIn('unrelated preference', context)
        self.assertNotIn('hidden project', context)
        self.assertEqual(self.service('PLEASE HELLO THANKS İÇİN TAMAM TEŞEKKÜRLER')._saved_context(), '')
        self.embed.assert_not_called()
        for record in [memory, note]:
            record.refresh_from_db()
            self.assertIsNone(record.last_accessed_at)

    def test_global_language_sql_search_and_recall_in_both_stores(self):
        cases = [
            ('Équipe documentation', 'equipe'), ('Haus', 'Häuser'),
            ('conexión', 'conexiones'), ('база', 'базы'),
            ('الكتاب', 'كتاب'), ('كتاب', 'الكتاب'), ('كِتَاب', 'كتاب'),
            ('डेटाबेस', 'डेटाबेस'), ('বাংলা', 'বাংলা'), ('தமிழ்', 'தமிழ்'),
            ('מסד', 'מסד'), ('βάση', 'βάση'), ('ქართული', 'ქართული'),
            ('መረጃ', 'መረጃ'), ('데이터', '데이터'), ('책', '책'),
            ('项目使用数据库管理文档', '数据库'), ('项目使用数据库管理文档', '库'),
            ('プロジェクトのデータベース設定', 'データベース'),
            ('ระบบฐานข้อมูลโครงการ', 'ฐานข้อมูล'),
            ('ຂໍ້ມູນ', 'ຂໍ້ມູນ'), ('ទិន្នន័យ', 'ទិន្នន័យ'), ('မှတ်ဉာဏ်', 'မှတ်ဉာဏ်'),
        ]
        for content, query in cases:
            with self.subTest(content=content, query=query):
                records = []
                for store in [MemoryService(self.user), NoteService(self.user, sandbox_uuid=self.project.pk)]:
                    record, _ = store.create({'content': content})
                    records.append(record)
                    results = store.search({'query': query}, semantic=False, touch=False)
                    self.assertIn(record.pk, [r.pk for r in results])
                self.embed.reset_mock()
                context = self.service(query)._saved_context()
                self.assertIn(content, context)
                self.embed.assert_not_called()
                for record in records:
                    record.refresh_from_db()
                    self.assertIsNone(record.last_accessed_at)

    def test_short_follow_up_uses_previous_user_turn(self):
        MemoryService(self.user).create({'content': 'Redis cluster uses three shards'})
        history = [
            {'role': 'user', 'content': 'How is Redis configured?'},
            {'role': 'assistant', 'content': 'It uses a cluster.'},
            {'role': 'user', 'content': 'peki staging?'},
        ]
        self.assertIn('three shards', self.service('peki staging?')._saved_context(history))
        self.assertEqual(self.service('peki staging?')._saved_context(), '')

    def test_saved_context_is_prepended_to_user_message_not_system(self):
        MemoryService(self.user).create({'content': 'Prefers Turkish answers <b>'})
        user_msg = Message.objects.create(conversation=self.conversation, role='user', content='Answer in Turkish')
        service = self.service('Answer in Turkish')
        service.current_request = SimpleNamespace(user=self.user, parent=user_msg)
        service.system_prompt = 'Custom prompt'
        service.attachments_context = ''
        service._model_catalog_guide = lambda: ''
        service._trim_messages_to_context = lambda messages: messages
        messages = service._build_messages()
        self.assertEqual([m['role'] for m in messages], ['system', 'user'])
        self.assertTrue(messages[0]['content'].startswith('Custom prompt'))
        self.assertNotIn('Turkish answers', messages[0]['content'])
        self.assertTrue(messages[1]['content'].startswith('<saved_context>'))
        self.assertTrue(messages[1]['content'].endswith('Answer in Turkish'))
        self.assertNotIn('<b>', messages[1]['content'])
        user_msg.refresh_from_db()
        self.assertEqual(user_msg.content, 'Answer in Turkish')

    def test_legacy_reindex_dry_run_has_no_api_calls_and_rebuild_tracks_model(self):
        memory = Memory.objects.create(user=self.user, content='Legacy preference', vector=[0, 1])
        self.embed.reset_mock()
        call_command('reindex_memories', dry_run=True, stdout=StringIO())
        self.embed.assert_not_called()
        call_command('reindex_memories', stdout=StringIO())
        memory.refresh_from_db()
        self.assertEqual(list(memory.vector), [1, 0, 0])
        self.assertEqual(memory.embedding_model, embedding_model_name())

    @patch('chat.services.memory_extraction.OpenAI')
    def test_extraction_accepts_only_explicit_quotes_and_tracks_source(self, client):
        message = Message.objects.create(conversation=self.conversation, role='user', content='I prefer Turkish. My name is Ada.')
        client.return_value.chat.completions.create.return_value.choices = [SimpleNamespace(message=SimpleNamespace(content=json.dumps({'facts': [
            {'content': 'I prefer Turkish', 'evidence': 'I prefer Turkish.', 'category': 'preference', 'label': 'language'},
            {'content': 'User likes Python', 'evidence': 'I prefer Turkish.', 'category': 'preference'},
            {'content': 'Invented name', 'evidence': 'Invented name', 'category': 'identity'},
        ]})))]
        self.assertEqual(extract_memories(self.user, message, self.conversation, **EXTRACTION_TARGET), 1)
        memory = Memory.objects.get()
        self.assertEqual(memory.content, 'I prefer Turkish')
        self.assertEqual(memory.source_message_id, message.pk)
        self.assertEqual(extract_memories(self.user, message, self.conversation, **EXTRACTION_TARGET), 0)
        self.assertEqual(Memory.objects.count(), 1)

    @patch('chat.services.memory_extraction.OpenAI')
    def test_extraction_updates_explicit_corrections_but_not_concurrent_edits(self, client):
        old, _ = MemoryService(self.user).create({'content': 'I prefer English', 'label': 'language'})
        message = Message.objects.create(conversation=self.conversation, role='user', content='I now prefer Turkish.')
        payload = {'facts': [{'content': 'I now prefer Turkish', 'evidence': 'I now prefer Turkish.', 'category': 'preference', 'replaces_uuid': str(old.pk)}]}
        client.return_value.chat.completions.create.return_value.choices = [SimpleNamespace(message=SimpleNamespace(content=json.dumps(payload)))]
        self.assertEqual(extract_memories(self.user, message, self.conversation, **EXTRACTION_TARGET), 1)
        old.refresh_from_db()
        self.assertEqual(old.content, 'I now prefer Turkish')
        def concurrent_edit(**kwargs):
            MemoryService(self.user).update({'uuid': str(old.pk), 'content': 'Manual correction'})
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(payload)))])
        client.return_value.chat.completions.create.side_effect = concurrent_edit
        self.assertEqual(extract_memories(self.user, message, self.conversation, **EXTRACTION_TARGET), 0)
        old.refresh_from_db()
        self.assertEqual(old.content, 'Manual correction')

    @patch('chat.services.memory_extraction.OpenAI')
    def test_opt_out_shared_context_and_assistant_messages_never_trigger_extraction(self, client):
        message = Message.objects.create(conversation=self.conversation, role='assistant', content='I prefer Turkish')
        self.assertEqual(extract_memories(self.user, message, self.conversation, **EXTRACTION_TARGET), 0)
        message.role = 'user'
        get_user_model().objects.filter(pk=self.user.pk).update(memory_enabled=False)
        self.assertEqual(extract_memories(self.user, message, self.conversation, **EXTRACTION_TARGET), 0)
        get_user_model().objects.filter(pk=self.user.pk).update(memory_enabled=True)
        WorkspaceMembership.objects.create(workspace=self.workspace, user=self.other)
        self.assertEqual(extract_memories(self.user, message, self.conversation, **EXTRACTION_TARGET), 0)
        client.assert_not_called()

    @patch('chat.services.memory_extraction.OpenAI')
    def test_opt_out_during_extraction_prevents_persistence(self, client):
        message = Message.objects.create(conversation=self.conversation, role='user', content='I prefer Turkish')
        def opt_out(**kwargs):
            get_user_model().objects.filter(pk=self.user.pk).update(memory_enabled=False)
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps({'facts': [{'content': message.content, 'evidence': message.content}]})))])
        client.return_value.chat.completions.create.side_effect = opt_out
        self.assertEqual(extract_memories(self.user, message, self.conversation, **EXTRACTION_TARGET), 0)
        self.assertFalse(Memory.objects.exists())

    @patch('chat.services.memory_extraction.OpenAI')
    def test_extraction_accepts_grounded_synthesized_statement_and_management_endpoints(self, client):
        message = Message.objects.create(
            conversation=self.conversation,
            role='user',
            content='Projelerimde dokümantasyonu Türkçe yazıyorum.',
        )
        client.return_value.chat.completions.create.return_value.choices = [SimpleNamespace(message=SimpleNamespace(content=json.dumps({'facts': [
            {'content': 'Dokümantasyon Türkçe', 'evidence': 'dokümantasyonu Türkçe yazıyorum', 'category': 'preference', 'label': 'docs', 'importance_score': 8},
        ]})))]
        self.assertEqual(extract_memories(self.user, message, self.conversation, **EXTRACTION_TARGET), 1)
        created = self.client.post('/memories/', {'content': 'Uses PostgreSQL pgvector', 'category': 'workspace', 'label': 'database', 'importance_score': 9}, format='json')
        self.assertEqual(created.status_code, 201)
        searched = self.client.get('/memories/', {'query': 'dokümantasyon'})
        self.assertEqual(searched.status_code, 200)
        self.assertEqual(len(searched.data), 1)
        session_hit = self.tool('session_search', {'query': 'dokümantasyon'})
        self.assertEqual(session_hit['count'], 1)

    @skipUnless(connection.vendor == 'postgresql', 'Requires PostgreSQL and pgvector')
    def test_real_semantic_search_returns_distance_and_handles_mixed_dimensions(self):
        match, _ = MemoryService(self.user).create({'content': 'A semantic-only result'})
        Memory.objects.create(user=self.user, content='Wrong dimensions', vector=[1, 0], embedding_model=embedding_model_name())
        Memory.objects.create(user=self.user, content='Wrong embedding space', vector=[1, 0, 0], embedding_model='other:model')
        Memory.objects.create(user=self.user, content='Legacy vector', vector=[1, 0, 0])
        results = MemoryService(self.user).search({'query': 'unrelated-query'})
        self.assertEqual([r.pk for r in results], [match.pk])
        self.assertAlmostEqual(results[0].distance, 0)

    @skipUnless(connection.vendor == 'postgresql', 'Requires PostgreSQL and pgvector')
    def test_sql_failure_recovers_inside_enclosing_transaction(self):
        from pgvector.django import L2Distance
        # Deliberately force the operator to use incompatible dimensions.
        MemoryService(self.user).create({'content': 'Recover text match'})
        self.embed.return_value = [1, 0]
        with patch('chat.services.memory_service.CosineDistance', side_effect=lambda *args: L2Distance('vector', [1, 0])):
            self.embed.return_value = [1, 0, 0]
            results = MemoryService(self.user).search({'query': 'Recover'})
        self.assertEqual(len(results), 1)


class EmbeddingCacheTests(TestCase):
    @patch('chat.services.utils.get_vector')
    def test_cache_key_changes_when_embedding_model_changes(self, vector):
        vector.side_effect = [[1, 0], [0, 1]]
        with override_settings(MEMORY_EMBEDDING_MODEL='openrouter:first'):
            self.assertEqual(get_vector_cached('Cache model test', 'review'), [1, 0])
        with override_settings(MEMORY_EMBEDDING_MODEL='openrouter:second'):
            self.assertEqual(get_vector_cached('Cache model test', 'review'), [0, 1])
        self.assertEqual(vector.call_count, 2)
