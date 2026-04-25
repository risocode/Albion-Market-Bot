from __future__ import annotations

from PySide6.QtCore import QEventLoop, QPoint, QRect, Qt, Signal
from PySide6.QtGui import QColor, QMouseEvent, QPainter, QPen
from PySide6.QtWidgets import QApplication, QWidget

from albion_bot.state.runtime_state import CaptureRegion


class RegionSelector(QWidget):
    region_selected = Signal(object)

    def __init__(self) -> None:
        super().__init__()
        self._start_point = QPoint()
        self._end_point = QPoint()
        self._is_dragging = False
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
        painter.fillRect(self.rect(), QColor(0, 0, 0, 70))
        if self._is_dragging:
            rect = QRect(self._start_point, self._end_point).normalized()
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.setPen(QPen(QColor(255, 80, 80), 2))
            painter.drawRect(rect)

    def mousePressEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton:
            self._start_point = event.globalPosition().toPoint()
            self._end_point = self._start_point
            self._is_dragging = True
            self.update()

    def mouseMoveEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self._is_dragging:
            self._end_point = event.globalPosition().toPoint()
            self.update()

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if event.button() != Qt.MouseButton.LeftButton:
            return
        self._end_point = event.globalPosition().toPoint()
        self._is_dragging = False
        rect = QRect(self._start_point, self._end_point).normalized()
        region = None
        if rect.width() > 2 and rect.height() > 2:
            region = CaptureRegion(
                left=rect.left(),
                top=rect.top(),
                width=rect.width(),
                height=rect.height(),
            )
        self.region_selected.emit(region)
        self.close()

    def keyPressEvent(self, event) -> None:  # noqa: N802
        if event.key() == Qt.Key.Key_Escape:
            self.region_selected.emit(None)
            self.close()
            return
        super().keyPressEvent(event)

    @staticmethod
    def select_region() -> CaptureRegion | None:
        app = QApplication.instance()
        if app is None:
            raise RuntimeError("QApplication must exist before selecting a region.")

        selector = RegionSelector()
        selected_region: CaptureRegion | None = None
        event_loop = QEventLoop()

        def _on_selected(region: CaptureRegion | None) -> None:
            nonlocal selected_region
            selected_region = region
            if event_loop.isRunning():
                event_loop.quit()

        selector.region_selected.connect(_on_selected)
        selector.destroyed.connect(lambda _obj=None: event_loop.quit())
        selector.show()
        selector.activateWindow()
        selector.raise_()
        event_loop.exec()

        return selected_region

