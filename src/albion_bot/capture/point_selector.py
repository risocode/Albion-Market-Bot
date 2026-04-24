from __future__ import annotations

from PySide6.QtCore import QEventLoop, QPoint, Qt, Signal
from PySide6.QtGui import QColor, QMouseEvent, QPainter, QPen
from PySide6.QtWidgets import QApplication, QWidget

from albion_bot.state.runtime_state import ScreenPoint


class PointSelector(QWidget):
    point_selected = Signal(object)

    def __init__(self) -> None:
        super().__init__()
        self._cursor_point = QPoint(0, 0)
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WidgetAttribute.WA_NoSystemBackground, True)
        self.setWindowState(Qt.WindowState.WindowFullScreen)
        self.setMouseTracking(True)
        self.setCursor(Qt.CursorShape.CrossCursor)

    def paintEvent(self, event) -> None:  # noqa: N802
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor(0, 0, 0, 40))
        painter.setPen(QPen(QColor(255, 80, 80), 2))
        painter.drawLine(self._cursor_point.x() - 12, self._cursor_point.y(), self._cursor_point.x() + 12, self._cursor_point.y())
        painter.drawLine(self._cursor_point.x(), self._cursor_point.y() - 12, self._cursor_point.x(), self._cursor_point.y() + 12)

    def mouseMoveEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        self._cursor_point = event.position().toPoint()
        self.update()

    def mousePressEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if event.button() != Qt.MouseButton.LeftButton:
            return
        point = event.position().toPoint()
        self.point_selected.emit(ScreenPoint(x=point.x(), y=point.y()))
        self.close()

    def keyPressEvent(self, event) -> None:  # noqa: N802
        if event.key() == Qt.Key.Key_Escape:
            self.point_selected.emit(None)
            self.close()
            return
        super().keyPressEvent(event)

    @staticmethod
    def select_point() -> ScreenPoint | None:
        app = QApplication.instance()
        if app is None:
            raise RuntimeError("QApplication must exist before selecting a point.")

        selector = PointSelector()
        selected: ScreenPoint | None = None
        event_loop = QEventLoop()

        def _on_point(point: ScreenPoint | None) -> None:
            nonlocal selected
            selected = point
            if event_loop.isRunning():
                event_loop.quit()

        selector.point_selected.connect(_on_point)
        selector.destroyed.connect(lambda _obj=None: event_loop.quit())
        selector.show()
        selector.activateWindow()
        selector.raise_()
        event_loop.exec()

        return selected

