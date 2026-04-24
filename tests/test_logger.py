from pathlib import Path

from albion_bot.logging.data_logger import DataLogger


def test_logger_appends_with_header(tmp_path: Path) -> None:
    output = tmp_path / "capture_log.csv"
    logger = DataLogger(output)

    logger.append_value(1200)
    logger.append_value(1400)

    lines = output.read_text(encoding="utf-8").strip().splitlines()
    assert lines[0] == "timestamp,value"
    assert len(lines) == 3
    assert lines[1].endswith(",1200")
    assert lines[2].endswith(",1400")


def test_logger_supports_empty_value(tmp_path: Path) -> None:
    output = tmp_path / "capture_log.csv"
    logger = DataLogger(output)

    logger.append_value(None)
    lines = output.read_text(encoding="utf-8").strip().splitlines()
    assert lines[1].endswith(",")

