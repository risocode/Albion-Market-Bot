from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Protocol

import pytesseract
from PIL import Image, ImageOps


class OCREngine(Protocol):
    def extract_text(self, image_path: Path) -> str:
        ...


class TesseractOCREngine:
    def __init__(self, tesseract_cmd: str | None = None) -> None:
        resolved_cmd = tesseract_cmd or _resolve_tesseract_path()
        if resolved_cmd:
            pytesseract.pytesseract.tesseract_cmd = resolved_cmd

    def extract_text(self, image_path: Path) -> str:
        with Image.open(image_path) as image:
            grayscale = ImageOps.grayscale(image)
            boosted = grayscale.point(lambda px: 255 if px > 150 else 0)
            config = "--oem 3 --psm 7 -c tessedit_char_whitelist=0123456789,."
            return pytesseract.image_to_string(boosted, config=config).strip()


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

