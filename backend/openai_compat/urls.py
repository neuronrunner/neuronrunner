from chat.views import stateful_openai_chat_completions
from django.urls import path

from .views import openai_chat_completions

urlpatterns = [
    path('v1/chat/completions', openai_chat_completions, name='openai_chat_completions'),
    path('v1/chat/completions/', openai_chat_completions),
    path('v1/responses', stateful_openai_chat_completions, name='openai_responses'),
    path('v1/responses/', stateful_openai_chat_completions),
]
