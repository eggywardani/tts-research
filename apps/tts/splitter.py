"""Sentence-aware text splitting for long-input generation.

OmniVoice (like most TTS models) degrades on very long inputs, so we split into
chunks and generate each separately, then concatenate. Ported from the
audio-processor-llm splitter — the chunking rules that produce natural breaks:

- Split ONLY at sentence terminators (. ! ? …), never at commas — comma-splitting
  chops sentences mid-phrase and makes the audio sound choppy.
- A sentence terminator is a boundary only when followed by an uppercase / non-cased
  letter or a "[" tag, so abbreviations like "U.S.A. is" don't split.
- ":" and ";" are hard boundaries (some TTS tokenizers silently truncate at them).
- Ellipsis "..." is a pause marker, never a split point.
- Over-long sentences fall back to word wrapping (last resort only).
- Short chunks (< MIN_CHUNK_LENGTH) are merged back into a neighbour.
- Chunk-size budget is per-language and scalable via TTS_CHUNK_SCALE.
"""

from __future__ import annotations

import os
from typing import List

import regex as re  # Unicode property classes (\p{Lu}, \p{Lo}) like the reference.

# ── Configuration ────────────────────────────────────────────────────────────
try:
    CHUNK_SCALE = max(0.1, float(os.environ.get("TTS_CHUNK_SCALE", "1.0")))
except ValueError:
    CHUNK_SCALE = 1.0

_BASE_CHUNK_LIMITS = {
    "en": 350,
    "es": 320, "pt": 320, "fr": 320, "it": 320, "de": 320, "id": 320,
    "ar": 240, "he": 240, "hi": 240,
    "zh-cn": 200, "ja": 200, "ko": 200,
}
CHUNK_LIMITS = {lang: round(lim * CHUNK_SCALE) for lang, lim in _BASE_CHUNK_LIMITS.items()}
DEFAULT_CHUNK_LIMIT = round(280 * CHUNK_SCALE)
MIN_CHUNK_LENGTH = 60

# Languages for which chunking is disabled (send the whole text in one pass).
_NO_CHUNK_LANGS = {
    s.strip().lower() for s in os.environ.get("TTS_NO_CHUNK_LANGS", "").split(",") if s.strip()
}

# ── Patterns ─────────────────────────────────────────────────────────────────
# Split at ". "/"! "/"? "/"؟ " only when followed by an uppercase Latin letter
# (\p{Lu}), a non-cased letter (\p{Lo} — Arabic/Hebrew/Hindi/CJK), or "[" (a tag).
# Lowercase Latin is excluded to avoid splitting abbreviations like "U.S.A. is".
_SENTENCE_TERMINATORS = re.compile(r"(?<=[.!?…؟])\s+(?=[\p{Lu}\p{Lo}\[])")
# Hard boundary for non-Arabic text: some TTS tokenizers truncate at ASCII ":"/";".
_COLON_HARD_TERMINATORS = re.compile(r"(?<=[:;])\s+")
# For Arabic-script text every sentence terminator is a hard boundary.
_ARABIC_HARD_TERMINATORS = re.compile(r"(?<=[.!?،؛؟:;])\s+")

_ARABIC_LIKE_LANGUAGES = {"ar", "he"}
_ELLIPSIS_PLACEHOLDER = "\x00ELLIPSIS\x00"
_SPEAKABLE = re.compile(r"[\p{L}\p{N}]")


def detect_language(text: str) -> str:
    """Detect language from Unicode code-point ranges; defaults to 'en'."""
    for ch in text:
        cp = ord(ch)
        if 0x4E00 <= cp <= 0x9FFF:
            return "zh-cn"
        if 0x3040 <= cp <= 0x309F or 0x30A0 <= cp <= 0x30FF:
            return "ja"
        if 0xAC00 <= cp <= 0xD7AF:
            return "ko"
        if 0x0600 <= cp <= 0x06FF:
            return "ar"
        if 0x0590 <= cp <= 0x05FF:
            return "he"
        if 0x0900 <= cp <= 0x097F:
            return "hi"
        if 0x0370 <= cp <= 0x03FF:
            return "el"
        if 0x0400 <= cp <= 0x04FF:
            return "ru"
    return "en"


def _has_speakable_content(text: str) -> bool:
    """True if text has at least one Unicode letter or digit."""
    return bool(_SPEAKABLE.search(text))


def split_text(text: str, language: str | None = None) -> List[str]:
    text = (text or "").strip()
    if not text:
        return []
    if language is None:
        language = detect_language(text)

    if language in _NO_CHUNK_LANGS:
        return [text] if _has_speakable_content(text) else []

    if language in _ARABIC_LIKE_LANGUAGES:
        chunks = _split_arabic(text, language)
    else:
        chunks = _split_inner(text, language)

    # Drop chunks with no speakable content (e.g. a lone trailing "..." or "-").
    return [c for c in chunks if _has_speakable_content(c)]


def _split_inner(text: str, language: str) -> List[str]:
    max_len = CHUNK_LIMITS.get(language, DEFAULT_CHUNK_LIMIT)
    processed = text.replace("...", _ELLIPSIS_PLACEHOLDER)

    # Hard-split at ":"/";" first — never merge across them.
    colon_segments = [s.strip() for s in _COLON_HARD_TERMINATORS.split(processed) if s.strip()]

    all_chunks: List[str] = []
    for segment in colon_segments:
        seg_chunks = _split_segment_by_sentences(segment, max_len)
        all_chunks.extend(_merge_short_chunks(seg_chunks, max_len))

    return [c.replace(_ELLIPSIS_PLACEHOLDER, "...") for c in all_chunks]


def _split_arabic(text: str, language: str) -> List[str]:
    """One sentence per chunk for RTL scripts — never merge across terminators."""
    max_len = CHUNK_LIMITS.get(language, DEFAULT_CHUNK_LIMIT)
    processed = text.replace("...", _ELLIPSIS_PLACEHOLDER)
    segments = _ARABIC_HARD_TERMINATORS.split(processed)

    chunks: List[str] = []
    for seg in segments:
        seg = seg.strip()
        if not seg:
            continue
        if len(seg) <= max_len:
            chunks.append(seg)
        else:
            chunks.extend(_word_wrap(seg, max_len))

    return [c.replace(_ELLIPSIS_PLACEHOLDER, "...") for c in chunks]


def _split_segment_by_sentences(segment: str, max_len: int) -> List[str]:
    if len(segment) <= max_len:
        return [segment]

    sentences = _SENTENCE_TERMINATORS.split(segment)
    chunks: List[str] = []
    buf = ""

    for sent in sentences:
        candidate = f"{buf} {sent}" if buf else sent
        if len(candidate) <= max_len:
            buf = candidate
            continue

        if buf:
            chunks.append(buf)
        if len(sent) <= max_len:
            buf = sent
        else:
            # Sentence itself exceeds the budget — word-wrap as a last resort.
            wrapped = _word_wrap(sent, max_len)
            chunks.extend(wrapped[:-1])
            buf = wrapped[-1] if wrapped else ""

    if buf:
        chunks.append(buf)
    return chunks


def _word_wrap(sent: str, max_len: int) -> List[str]:
    """Last-resort split on whitespace when a single sentence exceeds the budget."""
    out: List[str] = []
    buf = ""
    for word in sent.split():
        candidate = f"{buf} {word}" if buf else word
        if len(candidate) <= max_len:
            buf = candidate
        else:
            if buf:
                out.append(buf)
            buf = word
    if buf:
        out.append(buf)
    return out


def _merge_short_chunks(chunks: List[str], max_len: int) -> List[str]:
    """Merge undersized chunks into a neighbour so we don't emit tiny fragments."""
    if len(chunks) <= 1:
        return chunks

    merged: List[str] = []
    for chunk in chunks:
        if merged and len(chunk) < MIN_CHUNK_LENGTH:
            combined = f"{merged[-1]} {chunk}"
            if len(combined) <= max_len:
                merged[-1] = combined
                continue
        merged.append(chunk)

    # The last chunk may still be too short — fold it back if it fits.
    if len(merged) >= 2 and len(merged[-1]) < MIN_CHUNK_LENGTH:
        last = merged.pop()
        combined = f"{merged[-1]} {last}"
        if len(combined) <= max_len:
            merged[-1] = combined
        else:
            merged.append(last)

    return merged
