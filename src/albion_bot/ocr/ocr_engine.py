from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Protocol

import pytesseract
from PIL import Image, ImageOps, ImageStat


class OCREngine(Protocol):
    def extract_text(self, image_path: Path) -> str:
        ...


def _otsu_threshold(gray: Image.Image) -> int:
    hist = gray.histogram()
    total = gray.width * gray.height
    if total <= 0:
        return 128
    sum_total = sum(i * hist[i] for i in range(256))
    sum_b = 0
    w_b = 0
    max_var = 0.0
    threshold = 127
    for t in range(256):
        w_b += hist[t]
        if w_b == 0:
            continue
        w_f = total - w_b
        if w_f == 0:
            break
        sum_b += t * hist[t]
        m_b = sum_b / w_b
        m_f = (sum_total - sum_b) / w_f
        var_between = float(w_b * w_f) * (m_b - m_f) ** 2
        if var_between > max_var:
            max_var = var_between
            threshold = t
    return threshold


def _prepare_for_ocr(gray: Image.Image) -> Image.Image:
    w, h = gray.size
    short_side = min(w, h)
    if short_side > 0 and short_side < 80:
        scale = 80 / short_side
        gray = gray.resize(
            (max(1, int(w * scale)), max(1, int(h * scale))),
            Image.Resampling.LANCZOS,
        )
    elif short_side > 0:
        gray = gray.resize((w * 2, h * 2), Image.Resampling.LANCZOS)

    gray = ImageOps.autocontrast(gray, cutoff=1)
    mean = ImageStat.Stat(gray).mean[0]
    if mean < 120:
        gray = ImageOps.invert(gray)
    return gray


class TesseractOCREngine:
    def __init__(self, tesseract_cmd: str | None = None) -> None:
        resolved_cmd = tesseract_cmd or _resolve_tesseract_path()
        if resolved_cmd:
            pytesseract.pytesseract.tesseract_cmd = resolved_cmd

    def extract_text(self, image_path: Path) -> str:
        with Image.open(image_path) as image:
            grayscale = ImageOps.grayscale(image)
            prepared = _prepare_for_ocr(grayscale)
            thresh = _otsu_threshold(prepared)
            boosted = prepared.point(lambda px: 255 if px > thresh else 0)
            base_cfg = (
                "--oem 3 "
                "-c tessedit_char_whitelist=0123456789, "
                "-c classify_bln_numeric_mode=1 "
                "-c load_system_dawg=0 "
                "-c load_freq_dawg=0"
            )
            primary_cfg = f"{base_cfg} --psm 7"
            chunk = pytesseract.image_to_string(boosted, config=primary_cfg).strip()
            if chunk:
                return chunk
            fallback_cfg = f"{base_cfg} --psm 8"
            return pytesseract.image_to_string(boosted, config=fallback_cfg).strip()


def _resolve_tesseract_path() -> str | None:
    discovered = shutil.which("tesseract")
    if discovered:
        return discovered

    program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
    program_files_x86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    candidates = [
        Path(program_files) / "Tesseract-OCR" / "tesseract.exe",
        Path(program_files_x86) / "Tesseract-OCR" / "tesseract.exe",
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return None
