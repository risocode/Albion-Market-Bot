from __future__ import annotations

import re
from typing import Optional


NUMERIC_TOKEN_PATTERN = re.compile(r"(?<![A-Za-z0-9])\d[\d,.\s]{0,20}(?![A-Za-z0-9])")
OCR_FALLBACK_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])[0-9OolIS|][0-9OolIS|,.\s]{0,20}(?![A-Za-z0-9])"
)
OCR_REPLACEMENTS = str.maketrans(
    {
        "O": "0",
        "o": "0",
        "I": "1",
        "l": "1",
        "|": "1",
        "S": "5",
    }
)


def extract_numeric_token(raw_text: str) -> str:
    match = NUMERIC_TOKEN_PATTERN.search(raw_text)
    if not match:
        for candidate in OCR_FALLBACK_PATTERN.findall(raw_text):
            stripped = candidate.strip()
            if not stripped:
                continue
            if any(ch.isdigit() for ch in stripped) or len(stripped) >= 2:
                return stripped.translate(OCR_REPLACEMENTS)
        return ""
    return match.group(0).strip()


def normalize_numeric_text(raw_text: str) -> Optional[int]:
    token = extract_numeric_token(raw_text)
    if not token:
        return None

    cleaned = token.replace(" ", "")
    digits_only = "".join(ch for ch in cleaned if ch.isdigit())
    if not digits_only:
        return None
    return int(digits_only)

