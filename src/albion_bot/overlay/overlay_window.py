from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QLabel, QVBoxLayout, QWidget


class OverlayWindow(QWidget):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Albion Overlay Foundation")
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)
        self.setMinimumWidth(260)

        self._status_label = QLabel("Status: Idle")
        self._value_label = QLabel("Last Value: --")
        self._status_label.setStyleSheet("color: white; font-size: 14px;")
        self._value_label.setStyleSheet("color: #9ee37d; font-size: 16px; font-weight: bold;")

        container = QWidget()
        container.setStyleSheet("background-color: rgba(0, 0, 0, 170); border-radius: 8px;")
        layout = QVBoxLayout(container)
        layout.setContentsMargins(12, 10, 12, 10)
        layout.addWidget(self._status_label)
        layout.addWidget(self._value_label)

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.addWidget(container)

        self.move(20, 20)
        self.show()

    def set_status(self, status_text: str) -> None:
        self._status_label.setText(f"Status: {status_text}")

    def set_last_value(self, value: int | None) -> None:
        text = "--" if value is None else f"{value}"
        self._value_label.setText(f"Last Value: {text}")

    def toggle_visible(self) -> None:
        if self.isVisible():
            self.hide()
        else:
            self.show()

