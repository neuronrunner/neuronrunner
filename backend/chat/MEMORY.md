Memory stores private user facts. Model memory tools and automatic extraction honor
`memory_enabled`; the settings management endpoints remain available when it is off.
Personal memory is excluded from workspaces with other members.

Notes belong to a workspace and optionally a project. All members can read and edit
notes in that scope. A conversation fixes the scope server-side. Legacy calls without
routing use the user's private workspace; old unscoped records remain private. Invalid
or inaccessible scope identifiers fail instead of creating an unscoped note.

REST and model tools share `services/memory_service.py`. Replace/remove accept `uuid`;
legacy `old_text` is accepted only when exactly one record matches (an exact match has
priority). Ambiguous matches return 409 and candidate records.

Embeddings use one named space. Configure `MEMORY_EMBEDDING_MODEL` as
`openrouter:<model-id>` or `openai:<model-id>` (or leave empty to use text search). The existing
`OPENROUTER_VECTOR_MODEL` setting remains a default when supplied. Content edits clear
the old vector before generating a new one. Retrieval combines semantic and text
matches and ranks by relevance, importance and recency; provider failures retain text
search. The embedding cache includes the model name.

After deployment, run `python manage.py migrate`. Existing embeddings with unknown
models are used only by text search until rebuilt. Preview and rebuild them with:

```sh
python manage.py reindex_memories --dry-run --limit 100
python manage.py reindex_memories --limit 100
```

Set `MEMORY_EXTRACTION_MODEL` to select the auxiliary OpenRouter model (defaults to
`OPENROUTER_TITLE_MODEL`, then the existing DeepSeek title fallback). Extraction runs in
a daemon worker for funded platform requests, honors opt-out again before saving, and
does not use platform credentials for BYOK. It reads only the current user message,
stores verbatim evidence with a source message, and accepts explicit corrections
without overwriting concurrent manual edits. It needs `OPENROUTER_API_KEY`.

Each chat turn recalls a bounded amount of relevant text without network requests.
Recall uses shared text processing in `services/search_text.py`, with no language
allowlist. Unicode letters, numbers, combining marks and joiners are preserved during
tokenization. Case and Latin accents are folded; other scripts retain their vowel
marks. Short non-Latin words remain searchable. Han, Japanese, Thai, Lao, Khmer and
Myanmar runs use overlapping grapheme bigrams so terms can match inside unspaced text.
This is a lexical fallback rather than dictionary-based word segmentation.

All locally available NLTK stopword lists and Snowball languages are discovered
automatically. A language's stopword list is used when at least two distinct query
tokens belong to it, avoiding blindly removing a word because it is a stopword in
another language. Built-in English/Turkish filler and common multilingual greetings
also apply. Compatible stemmers produce namespaced keys; scripts without a stemmer
use literal/prefix matching. The existing five-letter Turkish prefix heuristic remains
for Latin text. Arabic stemmer instances are locked because NLTK mutates their state.
Stemming and stopword coverage depend on NLTK; universal tokenization does not require
a language model. This supports text in any script, not translation or complete
morphological analysis for every language.

SQL candidates use word-start prefixes with Unicode spelling variants. Arabic stem
and unsegmented-run candidates can also match inside a word; full term/stem checks
then determine relevance. Candidate retrieval remains capped at 100 records.
The Docker image downloads the NLTK stopwords corpus at build time; other installs
can run `python -m nltk.downloader -d /usr/local/share/nltk_data stopwords` once.
Missing corpus data falls back to built-in stopwords without runtime downloads;
Stemming itself does not require downloaded data. Missing NLTK retains Unicode literal
matching and built-in stopwords. The `regex` dependency supplies Unicode script and
grapheme properties.
Recall needs two matching terms for messages with more than three terms, and
borrows the previous user turn for short follow-ups. It is prepended to the current
user message inside `<saved_context>` (not persisted, not a system message) so the
single system message and the history stay cacheable. Recall does not update
`last_accessed_at`. The model can use search tools for semantic recall. Notes
continue to work when personal memory is disabled.
