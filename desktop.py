"""Work Tracker as a desktop app: opening it starts the server, closing the window stops it.

Run:  python desktop.py   (or open "Work Tracker.app", made by make_app.sh)

A running timer survives closing the app: it's stored as a start time in tracker.db, so it shows the
right time again when the app opens. The menu bar, the come-back reminder and the phone snapshot only
work while the app is open.
"""
import os
import sys
import threading

import webview
from werkzeug.serving import make_server

import app as tracker

PORT = int(os.environ.get("PORT", 47474))


def set_dock_icon():
    """Started from a script, macOS shows the Python rocket; show the tracker's icon instead."""
    icon = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs", "icon.png")
    if sys.platform != "darwin" or not os.path.isfile(icon):
        return
    from AppKit import NSApplication, NSImage
    NSApplication.sharedApplication().setApplicationIconImage_(NSImage.alloc().initWithContentsOfFile_(icon))


if __name__ == "__main__":
    tracker.load_workflow()
    try:
        server = make_server("localhost", PORT, tracker.app, threaded=True)
    except OSError:  # already running (e.g. autostart.sh): show that one, and leave it running
        print(f" * Port {PORT} is in use, showing the server that's already running", file=sys.stderr)
        server = None
    if server:
        tracker.start_background()
        threading.Thread(target=server.serve_forever, kwargs={"poll_interval": None}, daemon=True).start()

    webview.create_window("Work Tracker", f"http://localhost:{PORT}", width=1280, height=860, min_size=(420, 500))
    set_dock_icon()
    webview.start()
    # The window is closed: returning ends the process, and the server thread with it.
