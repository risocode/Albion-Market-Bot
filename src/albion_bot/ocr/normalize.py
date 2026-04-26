from __future__ import annotations

from itertools import combinations
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
_MALFORMED_COMMA_GROUP = re.compile(r"(?<!\d)(\d{1,3}),\s*(\d{4})(?!\d)")
_MALFORMED_COMMA_GROUP_DOUBLE = re.compile(r"(?<!\d)(\d{1,3}),\s*(\d{5})(?!\d)")
_MALFORMED_COMMA_GROUP_TRIPLE = re.compile(r"(?<!\d)(\d{1,3}),\s*(\d{6})(?!\d)")

# Collapse comma + optional spaces between digits (e.g. "888, 888" -> "888888").
_DIGIT_COMMA_GAP = re.compile(r"(?<=\d),\s*(?=\d)")
# Collapse horizontal spaces between digits for OCR (e.g. "12 345" -> "12345")
# but do not cross line breaks (prevents "319000\n319000" from becoming "319000319000"),
# and do not collapse the separator after tier fragments like "7.1".
_DIGIT_SPACE_GAP = re.compile(r"(?<!\d\.\d)[ \t]+(?=\d)")
_VALID_COMMA_FORMAT = re.compile(r"^\d{1,3}(,\d{3})+$")
_SUSPICIOUS_ZERO_INFLATION_HINT = re.compile(r"(,\s*0\d{2},\s*\d{3})|(,\d{3}0{1,3}\b)")
_SUSPICIOUS_MIDDLE_SHIFT = re.compile(r",\s*0\d{2},\s*\d{3}")
_STRUCTURE_TOKEN = re.compile(r"\d[\d,]{0,20}")


def extract_numeric_token(raw_text: str) -> str:
    """Return the first numeric-looking token (legacy / tests)."""
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


def _digit_runs_after_collapse(text: str) -> list[tuple[int, int]]:
    """Parse integer value and digit-length for each contiguous digit run."""
    collapsed = _DIGIT_COMMA_GAP.sub("", text)
    collapsed = _DIGIT_SPACE_GAP.sub("", collapsed)
    runs: list[tuple[int, int]] = []
    for m in re.finditer(r"\d+", collapsed):
        s = m.group(0)
        runs.append((int(s), len(s)))
    return runs


def _dedupe_back_to_back_repeat(value: int, digits: int) -> tuple[int, int]:
    """Collapse exact duplicated runs: 319000319000 -> 319000."""
    if digits < 6 or digits % 2 != 0:
        return value, digits
    s = str(value).zfill(digits)
    half = digits // 2
    if half < 5:
        return value, digits
    if s[:half] == s[half:]:
        return int(s[:half]), half
    return value, digits


def _runs_from_translated_token(raw_text: str) -> list[tuple[int, int]]:
    token = extract_numeric_token(raw_text)
    if not token:
        return []
    return _digit_runs_after_collapse(token.translate(OCR_REPLACEMENTS))


def _runs_from_malformed_comma_fix(raw_text: str) -> list[tuple[int, int]]:
    """
    Recover prices when OCR appends one extra trailing digit after thousands comma.
    Example: '38,3090' -> treat as 38,309.
    """
    runs: list[tuple[int, int]] = []
    for m in _MALFORMED_COMMA_GROUP.finditer(raw_text):
        left = m.group(1)
        right = m.group(2)
        if not right.endswith("0"):
            continue
        corrected = f"{left}{right[:-1]}"
        if corrected.isdigit():
            runs.append((int(corrected), len(corrected)))
    for m in _MALFORMED_COMMA_GROUP_DOUBLE.finditer(raw_text):
        left = m.group(1)
        right = m.group(2)
        if not right.endswith("00"):
            continue
        corrected = f"{left}{right[:-2]}"
        if corrected.isdigit():
            runs.append((int(corrected), len(corrected)))
    for m in _MALFORMED_COMMA_GROUP_TRIPLE.finditer(raw_text):
        left = m.group(1)
        right = m.group(2)
        if not right.endswith("000"):
            continue
        corrected = f"{left}{right[:-3]}"
        if corrected.isdigit():
            runs.append((int(corrected), len(corrected)))
    return runs


def _runs_from_zero_removed_candidates(raw_text: str, max_removed: int = 3) -> list[tuple[int, int]]:
    """
    Generate digit-run candidates by removing 1..max_removed zero characters.
    This helps recover inflated OCR values like 4,013,200 vs expected 40,132.
    """
    runs: list[tuple[int, int]] = []
    seen: set[tuple[int, int]] = set()
    for value, digits in _digit_runs_after_collapse(raw_text):
        s = str(value).zfill(digits)
        if len(s) < 4:
            continue
        zero_positions = [idx for idx, ch in enumerate(s) if ch == "0"]
        if not zero_positions:
            continue
        max_count = min(max_removed, len(zero_positions))
        for remove_count in range(1, max_count + 1):
            combo_iter = combinations(zero_positions, remove_count)
            for n_combo, idx_tuple in enumerate(combo_iter):
                if n_combo >= 300:
                    break
                keep_chars = [ch for idx, ch in enumerate(s) if idx not in idx_tuple]
                cand = "".join(keep_chars).lstrip("0")
                if not cand or len(cand) < 4:
                    continue
                pair = (int(cand), len(cand))
                if pair not in seen:
                    seen.add(pair)
                    runs.append(pair)
    return runs


def _digits_only(text: str) -> str:
    return "".join(ch for ch in str(text or "") if ch.isdigit())


def _format_with_commas_from_digits(digits: str) -> str:
    d = str(digits or "").lstrip("0")
    if not d:
        return "0"
    parts = []
    while d:
        parts.append(d[-3:])
        d = d[:-3]
    return ",".join(reversed(parts))


def _runs_from_structure_reconstruction(raw_text: str) -> list[tuple[int, int]]:
    runs: list[tuple[int, int]] = []
    seen: set[tuple[int, int]] = set()
    translated = str(raw_text or "").translate(OCR_REPLACEMENTS)
    for token in _STRUCTURE_TOKEN.findall(translated):
        if not token:
            continue
        compact = token.strip(",")
        if "," in compact and _VALID_COMMA_FORMAT.match(compact):
            digits = _digits_only(compact)
            if digits:
                pair = (int(digits), len(digits))
                if pair not in seen:
                    seen.add(pair)
                    runs.append(pair)
        digits = _digits_only(compact)
        if digits:
            pair = (int(digits), len(digits))
            if pair not in seen:
                seen.add(pair)
                runs.append(pair)
    return runs


def normalize_numeric_text(raw_text: str) -> Optional[str]:
    """
    Pick the best market-style price from OCR text.

    Prefer the longest digit run with at least 4 digits (avoids tier fragments like 7 / 1
    when a full silver price is present). Falls back to shorter runs for low prices.
    """
    if not raw_text or not raw_text.strip():
        return None

    structure_runs = _runs_from_structure_reconstruction(raw_text)
    malformed_runs = _runs_from_malformed_comma_fix(raw_text)
    runs = structure_runs + _digit_runs_after_collapse(raw_text) + _runs_from_translated_token(raw_text) + malformed_runs
    runs = [(v, n) for v, n in runs if n >= 2]
    if "," in raw_text and _SUSPICIOUS_ZERO_INFLATION_HINT.search(raw_text):
        runs = runs + _runs_from_zero_removed_candidates(raw_text)
    if not runs:
        return None

    normalized_runs = [_dedupe_back_to_back_repeat(v, n) for v, n in runs]
    value_set = {v for v, _ in normalized_runs}
    suspicious_middle_shift = bool(_SUSPICIOUS_MIDDLE_SHIFT.search(raw_text))
    preferred_values = {v for v, _ in malformed_runs}
    if not suspicious_middle_shift:
        preferred_values.update({v for v, _ in structure_runs})
    scored_runs: list[tuple[int, int, int]] = []
    for v, n in normalized_runs:
        # If OCR emitted an extra trailing zero and the /10 value is also present,
        # prefer the shorter (likely correct) value.
        trailing_zero_anomaly = 0
        if n >= 5 and v % 10 == 0 and (v // 10) in value_set:
            trailing_zero_anomaly = 1
        if n >= 6 and v % 100 == 0 and (v // 100) in value_set:
            trailing_zero_anomaly = 1
        if n >= 7 and v % 1000 == 0 and (v // 1000) in value_set:
            trailing_zero_anomaly = 1
        if suspicious_middle_shift and n >= 7 and v % 100 == 0:
            trailing_zero_anomaly = 1
        preferred = 1 if v in preferred_values else 0
        scored_runs.append((v, n, trailing_zero_anomaly, preferred))

    long_runs = [(v, n, bad, pref) for v, n, bad, pref in scored_runs if n >= 4]
    if long_runs:
        best = max(long_runs, key=lambda x: (x[3], 1 - x[2], x[1], x[0]))[0]
        return _format_with_commas_from_digits(str(best))

    medium = [(v, n, bad, pref) for v, n, bad, pref in scored_runs if n >= 2]
    if medium:
        best = max(medium, key=lambda x: (x[3], 1 - x[2], x[1], x[0]))[0]
        return _format_with_commas_from_digits(str(best))

    best = max(scored_runs, key=lambda x: (x[3], 1 - x[2], x[1], x[0]))[0]
    return _format_with_commas_from_digits(str(best))
