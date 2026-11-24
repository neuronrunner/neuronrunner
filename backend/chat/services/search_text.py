"""Language-independent lexical retrieval with optional NLTK enhancements.

Every Unicode script has a literal fallback. Available NLTK stopword lists and
Snowball stemmers are discovered locally; no language allowlist or downloads
are required at runtime. Unsegmented scripts use grapheme bigrams, not guessed
linguistic word boundaries. This is lexical retrieval, not translation.
"""
import logging
import re
import unicodedata
from functools import lru_cache
from threading import Lock

import regex

logger = logging.getLogger(__name__)

TOKEN = regex.compile(r"[\p{L}\p{N}_][\p{L}\p{M}\p{N}_\u200c\u200d]*")
LATIN = regex.compile(r"\p{Script=Latin}")
_UNSEGMENTED_SCRIPTS = (
    r"\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}"
    r"\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}"
)
UNSEGMENTED = regex.compile(f"[{_UNSEGMENTED_SCRIPTS}][{_UNSEGMENTED_SCRIPTS}\\p{{M}}]*")
GRAPHEME = regex.compile(r"\X")
MAX_TERMS = 12
MIN_TERM_LENGTH = 3
TURKISH_STEM_LENGTH = 5
# Snowball's remaining current algorithms use Latin scripts. A script with no
# compatible algorithm retains its literal key rather than an English stem.
_STEMMER_SCRIPTS = {"arabic": "Arabic", "russian": "Cyrillic"}

# Fallback when the NLTK corpus is unavailable, plus conversational filler that
# the corpora lack (greetings, thanks, requests).
BUILTIN_STOPWORDS = """
the and for are but not you your yours with this that these those from have has had was were
will would can could should what which who whom whose when where why how all any some its into
onto about over under than then them they their there here also just like more most much many
very such only own same other each few both use using used make get got please want need know
think tell show give let lets does did doing done been being out off our ours she her his him
yes okay thanks thank hello hey now
bir ile için ama fakat veya değil gibi kadar daha çok şey şeyi bunu şunu onu bunun şunun onun
bana beni benim sana seni senin biz bize bizim siz size sizin onlar onları mısın misin musun
müsün nasıl neden niye nerede nedir hangi kim var yok olan olarak olur oldu olsun ise eğer şimdi
sonra önce hem her hiç tüm bütün peki tamam evet hayır lütfen yap yapar yapalım yapın merhaba
selam teşekkür teşekkürler sağol sağolun şöyle böyle diye üzere çünkü zaten bile sadece artık
hala hâlâ bence acaba bak yani işte
hola gracias bonjour merci hallo danke ciao grazie obrigado obrigada
привет спасибо здравствуйте مرحبا شكرا 你好 谢谢 您好 こんにちは ありがとう 안녕 감사합니다
""".split()


def fold(text: str) -> str:
    """Fold Latin accents/case without dropping other scripts' vowel marks."""
    text = unicodedata.normalize("NFKC", text).replace("İ", "i").replace("ı", "i").casefold()
    chars = []
    latin_base = False
    for char in text:
        if unicodedata.category(char).startswith("M"):
            if not latin_base:
                chars.append(char)
            continue
        latin_base = "LATIN" in unicodedata.name(char, "")
        if latin_base:
            chars.extend(c for c in unicodedata.normalize("NFD", char) if not unicodedata.category(c).startswith("M"))
        else:
            chars.append(char)
    return unicodedata.normalize("NFC", "".join(chars))


@lru_cache(maxsize=1)
def stopwords() -> dict:
    """All locally available lists, kept separate to avoid cross-language loss."""
    lists = {"builtin": frozenset(fold(word) for word in BUILTIN_STOPWORDS)}
    try:
        from nltk.corpus import stopwords as corpus
        for language in corpus.fileids():
            lists[language] = frozenset(fold(word) for word in corpus.words(language))
    except (ImportError, LookupError):
        logger.info("NLTK stopwords corpus unavailable; using built-in lists")
    return lists


@lru_cache(maxsize=1)
def _stemmers():
    try:
        from nltk.stem.snowball import SnowballStemmer
        return {
            language: (regex.compile(rf"\p{{Script={_STEMMER_SCRIPTS.get(language, 'Latin')}}}"),
                       SnowballStemmer(language).stem, Lock())
            for language in SnowballStemmer.languages if language != "porter"
        }
    except ImportError:
        return {}


@lru_cache(maxsize=4096)
def keys(word: str) -> frozenset:
    """Namespaced stems prevent two different algorithms' output colliding."""
    result = {("literal", word)}
    if UNSEGMENTED.fullmatch(word):
        return frozenset(result)
    if LATIN.search(word) and len(word) >= TURKISH_STEM_LENGTH:
        result.add(("turkish-prefix", word[:TURKISH_STEM_LENGTH]))
    for language, (script, stem, lock) in _stemmers().items():
        if script.search(word):
            # NLTK's Arabic stemmer mutates instance state during stemming.
            with lock:
                root = fold(stem(word))
            if len(root) >= 2:
                result.add((language, root))
    return frozenset(result)


def tokens(text: str) -> list:
    """Keep combining marks and split unsegmented runs into grapheme bigrams."""
    result = []
    for word in TOKEN.findall(fold(text)):
        start = 0
        for match in UNSEGMENTED.finditer(word):
            if match.start() > start:
                result.append(word[start:match.start()])
            run = match.group()
            result.append(run)
            graphemes = GRAPHEME.findall(run)
            result.extend(left + right for left, right in zip(graphemes, graphemes[1:]))
            start = match.end()
        if start < len(word):
            result.append(word[start:])
    return result


def search_terms(query: str, limit: int = MAX_TERMS) -> list:
    """Meaningful terms in any script; short non-Latin terms remain searchable."""
    if limit <= 0:
        return []
    words = tokens(query)
    lists = stopwords()
    blocked = set(lists["builtin"])
    unique = set(words)
    for language, language_words in lists.items():
        if language != "builtin" and len(unique & language_words) >= 2:
            blocked.update(language_words)
    terms = []
    for token in words:
        # Do not manufacture meaningful bigrams from an all-filler CJK/Thai run.
        if UNSEGMENTED.fullmatch(token) and any(token in word for word in unique & blocked):
            continue
        long_enough = len(token) >= MIN_TERM_LENGTH or (not LATIN.search(token) and any(c.isalpha() for c in token))
        if long_enough and token not in blocked and token not in terms:
            terms.append(token)
            if len(terms) == limit:
                break
    return terms


@lru_cache(maxsize=1)
def _latin_variants() -> dict:
    """Reverse Latin folding for SQL candidates, including compatibility forms."""
    variants = {}
    for start, end in [(0x41, 0x250), (0x1E00, 0x1F00), (0x2C60, 0x2C80),
                       (0xA720, 0xA800), (0xAB30, 0xAB70), (0xFF00, 0xFFF0)]:
        for codepoint in range(start, end):
            char = chr(codepoint)
            if "LATIN" in unicodedata.name(char, ""):
                normalized = fold(char)
                if len(normalized) == 1:
                    variants.setdefault(normalized, set()).add(char)
    return {key: "[" + re.escape("".join(sorted(chars | {key}))) + "][\u0300-\u036f]*"
            for key, chars in variants.items()}


def candidate_patterns(terms: list) -> list:
    """Portable SQL prefilters; unsegmented terms can occur inside a run."""
    variants = _latin_variants()
    patterns = set()
    for term in terms:
        boundary = "" if UNSEGMENTED.fullmatch(term) else r"(^|\W)"
        for language, root in keys(term):
            prefix = root[:MIN_TERM_LENGTH]
            pieces = []
            index = 0
            while index < len(prefix):
                if prefix[index:index + 2] == "ss":
                    pieces.append("(?:" + variants["s"] * 2 + "|[ßẞ])")
                    index += 2
                else:
                    char = prefix[index]
                    if char in variants:
                        pieces.append(variants[char])
                    else:
                        decomposed = unicodedata.normalize("NFD", char)
                        literal = re.escape(char)
                        if decomposed != char:
                            literal = "(?:" + literal + "|" + re.escape(decomposed) + ")"
                        if language == "arabic" and unicodedata.category(char).startswith("L"):
                            literal += "[\u064b-\u065f\u0670]*"
                        pieces.append(literal)
                    index += 1
            # Arabic stemming can remove a leading article. Retrieve broadly,
            # then require a matching full, namespaced stem in matched_terms.
            patterns.add(("" if language == "arabic" else boundary) + "".join(pieces))
    return sorted(patterns)


def matched_terms(content: str, terms: list) -> int:
    """Count term coverage with optional inflection and unsegmented-run hits."""
    words = set(tokens(content))
    stems = set().union(*(keys(word) for word in words)) if words else set()
    return sum(
        1 for term in terms if keys(term) & stems or any(
            term in word if UNSEGMENTED.fullmatch(term) and UNSEGMENTED.fullmatch(word)
            else word.startswith(term)
            for word in words
        )
    )
