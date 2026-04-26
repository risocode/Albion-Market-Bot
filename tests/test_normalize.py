from albion_bot.ocr.normalize import extract_numeric_token, normalize_numeric_text


def test_extract_numeric_token_from_mixed_text() -> None:
    assert extract_numeric_token("Price: 1,200 silver") == "1,200"


def test_normalize_numeric_text_keeps_digits_only() -> None:
    assert normalize_numeric_text("1,200") == "1,200"
    assert normalize_numeric_text("12 345") == "12,345"


def test_normalize_numeric_text_handles_ocr_substitutions() -> None:
    assert normalize_numeric_text("I,O00") == "1,000"
    assert normalize_numeric_text("S500") == "5,500"


def test_normalize_numeric_text_with_no_number_returns_none() -> None:
    assert normalize_numeric_text("no value") is None


def test_normalize_prefers_long_price_over_tier_fragment() -> None:
    assert normalize_numeric_text("Carving Sword 7.1  819,981") == "819,981"


def test_normalize_collapses_comma_spaced_thousands() -> None:
    assert normalize_numeric_text("silver 888, 888 each") == "888,888"


def test_normalize_picks_longest_digit_run() -> None:
    assert normalize_numeric_text("x 12 y 888888 z") == "888,888"


def test_normalize_does_not_concatenate_duplicate_lines() -> None:
    assert normalize_numeric_text("319000\n319000") == "319,000"


def test_normalize_collapses_back_to_back_repeat_run() -> None:
    assert normalize_numeric_text("319000319000") == "319,000"


def test_normalize_prefers_non_times_ten_candidate() -> None:
    assert normalize_numeric_text("38309\n383090") == "38,309"


def test_normalize_fixes_malformed_comma_group() -> None:
    assert normalize_numeric_text("38,3090") == "38,309"


def test_normalize_fixes_malformed_comma_group_with_double_zero() -> None:
    assert normalize_numeric_text("40,13200") == "40,132"


def test_normalize_prefers_non_times_hundred_candidate() -> None:
    assert normalize_numeric_text("40132\n4013200") == "40,132"


def test_normalize_fixes_malformed_comma_group_with_triple_zero() -> None:
    assert normalize_numeric_text("40,132000") == "40,132"


def test_normalize_prefers_non_times_thousand_candidate() -> None:
    assert normalize_numeric_text("40132\n40132000") == "40,132"


def test_normalize_trailing_zero_inflation_from_comma_value() -> None:
    assert normalize_numeric_text("78,8520") == "78,852"


def test_normalize_trailing_three_zero_inflation_from_comma_value() -> None:
    assert normalize_numeric_text("78,852000") == "78,852"


def test_normalize_middle_zero_shift_comma_pattern() -> None:
    assert normalize_numeric_text("4,013,200") == "40,132"


def test_normalize_prefers_correct_value_when_inflated_alternative_exists() -> None:
    assert normalize_numeric_text("40,132\n4,013,200") == "40,132"


def test_normalize_reformats_plain_digits_to_comma() -> None:
    assert normalize_numeric_text("40132") == "40,132"


def test_normalize_keeps_already_valid_value_unchanged() -> None:
    assert normalize_numeric_text("78,852") == "78,852"

