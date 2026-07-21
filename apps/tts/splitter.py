"""Sentence-aware text splitting for long-input generation.

OmniVoice (like most TTS models) degrades on very long inputs, so we split into
chunks on sentence boundaries and generate each separately, then concatenate.
Small enough to keep the experiment simple; close enough to production's intent.
"""

import re
from typing import List

# Sentence terminators for latin + CJK punctuation.
_SENT_SPLIT = re.compile(r"(?<=[.!?。！？…])\s+")

# Clause boundaries (commas/semicolons/colons + CJK equivalents) — used to break
# an over-long sentence at a natural pause instead of mid-phrase.
_CLAUSE_SPLIT = re.compile(r"(?<=[,;:，、；：])\s+")


def split_text(text: str, max_chars: int = 240) -> List[str]:
    text = (text or "").strip()
    if not text:
        return []
    if len(text) <= max_chars:
        return [text]

    sentences = [s.strip() for s in _SENT_SPLIT.split(text) if s.strip()]
    chunks: List[str] = []
    buf = ""

    for sent in sentences:
        # A single sentence longer than the budget: hard-wrap on whitespace.
        if len(sent) > max_chars:
            if buf:
                chunks.append(buf)
                buf = ""
            chunks.extend(_hard_wrap(sent, max_chars))
            continue

        if not buf:
            buf = sent
        elif len(buf) + 1 + len(sent) <= max_chars:
            buf = f"{buf} {sent}"
        else:
            chunks.append(buf)
            buf = sent

    if buf:
        chunks.append(buf)
    return chunks


def _hard_wrap(sent: str, max_chars: int) -> List[str]:
    """Split an over-long sentence, preferring clause boundaries (commas/etc.) so
    each piece ends at a natural pause rather than mid-phrase. Falls back to word
    wrapping only for a clause that is itself longer than the budget."""
    clauses = [c.strip() for c in _CLAUSE_SPLIT.split(sent) if c.strip()]
    out: List[str] = []
    buf = ""
    for cl in clauses:
        if len(cl) > max_chars:
            if buf:
                out.append(buf)
                buf = ""
            out.extend(_word_wrap(cl, max_chars))
            continue
        if not buf:
            buf = cl
        elif len(buf) + 1 + len(cl) <= max_chars:
            buf = f"{buf} {cl}"
        else:
            out.append(buf)
            buf = cl
    if buf:
        out.append(buf)
    return out


def _word_wrap(sent: str, max_chars: int) -> List[str]:
    """Last-resort split on whitespace when a single clause exceeds the budget."""
    words = sent.split()
    out: List[str] = []
    buf = ""
    for w in words:
        if not buf:
            buf = w
        elif len(buf) + 1 + len(w) <= max_chars:
            buf = f"{buf} {w}"
        else:
            out.append(buf)
            buf = w
    if buf:
        out.append(buf)
    return out
