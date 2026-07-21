"""Sentence-aware text splitting for long-input generation.

OmniVoice (like most TTS models) degrades on very long inputs, so we split into
chunks on sentence boundaries and generate each separately, then concatenate.
Small enough to keep the experiment simple; close enough to production's intent.
"""

import re
from typing import List

# Sentence terminators for latin + CJK punctuation.
_SENT_SPLIT = re.compile(r"(?<=[.!?。！？…])\s+")


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
