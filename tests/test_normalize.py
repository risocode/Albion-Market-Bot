from albion_bot.ocr.normalize import extract_numeric_token, normalize_numeric_text


def test_extract_numeric_token_from_mixed_text() -> None:
    assert extract_numeric_token("Price: 1,200 silver") == "1,200"


def test_normalize_numeric_text_keeps_digits_only() -> None:
    assert normalize_numeric_text("1,200") == 1200
    assert normalize_numeric_text("12 345") == 12345


def test_normalize_numeric_text_handles_ocr_substitutions() -> None:
    assert normalize_numeric_text("I,O00") == 1000
    assert normalize_numeric_text("S500") == 5500


def test_normalize_numeric_text_with_no_number_returns_none() -> None:
    assert normalize_numeric_text("no value") is None

