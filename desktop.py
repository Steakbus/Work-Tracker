"""Work Tracker as a desktop app: opening it starts the server, closing the window stops it.

Run:  python desktop.py   (or open "Work Tracker.app", made by make_app.sh)

A running timer survives closing the app: it's stored as a start time in tracker.db, so it shows the
right time again when the app opens. The menu bar, the come-back reminder and the phone snapshot only
work while the app is open.
"""
import os
import sys
import threading
import time

import webview
from werkzeug.serving import make_server

import app as tracker

PORT = int(os.environ.get("PORT", 47474))


ICON = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs", "icon.png")
# Tint colours of System Settings → Appearance → Icon & widget style → Tinted, and the accent colours it
# can follow (AppleAccentColor: -1 graphite … 6 pink; not set = blue).
TINTS = {"blue": (0.0, 0.48, 1.0), "purple": (0.65, 0.33, 0.85), "pink": (1.0, 0.25, 0.55), "red": (1.0, 0.27, 0.23),
         "orange": (1.0, 0.58, 0.0), "yellow": (1.0, 0.8, 0.0), "green": (0.2, 0.78, 0.35), "graphite": (0.6, 0.6, 0.62)}
ACCENTS = {-1: "graphite", 0: "red", 1: "orange", 2: "yellow", 3: "green", 4: "blue", 5: "purple", 6: "pink"}


def icon_style():
    """(style, dark, tint) from System Settings → Appearance → Icon & widget style; style is regular, clear
    or tinted (the Dark style needs nothing: the icon has no background to darken)."""
    from CoreFoundation import CFPreferencesAppSynchronize, CFPreferencesCopyAppValue, kCFPreferencesAnyApplication
    CFPreferencesAppSynchronize(kCFPreferencesAnyApplication)  # read it fresh, not from this process' cache
    get = lambda key: CFPreferencesCopyAppValue(key, kCFPreferencesAnyApplication)
    theme = str(get("AppleIconAppearanceTheme") or "")  # e.g. TintedDark, ClearAutomatic; not set = default
    dark = theme.endswith("Dark") or (not theme.endswith("Light") and get("AppleInterfaceStyle") == "Dark")
    style = "tinted" if theme.startswith("Tinted") else "clear" if theme.startswith("Clear") else "regular"
    name = str(get("AppleIconAppearanceTintColor") or "")
    custom = str(get("AppleIconAppearanceCustomTintColor") or "").split()
    if name == "Other" and len(custom) >= 3:
        tint = tuple(float(c) for c in custom[:3])
    else:
        accent = get("AppleAccentColor")
        tint = TINTS.get(name.lower()) or TINTS[ACCENTS.get(int(accent) if accent is not None else 4, "blue")]
    return style, dark, tint


def styled_icon(style, dark, tint):
    """The Dock icon for an icon style: the normal icon, or for Clear and Tinted a one-colour version on a
    rounded square like the other apps get: the ring and hands in the colour, the dark face fading out."""
    from AppKit import NSBezierPath, NSCIImageRep, NSColor, NSCompositingOperationSourceOver, NSImage, NSMakeRect, NSZeroRect
    from Foundation import NSURL
    from Quartz import CIFilter, CIImage, CIVector
    if style == "regular":
        return NSImage.alloc().initWithContentsOfFile_(ICON)
    if style == "clear":
        color, background = ((1, 1, 1), (1, 1, 1, .16)) if dark else ((.24, .24, .26), (1, 1, 1, .55))
    elif dark:
        color, background = tint, tuple(.1 + .08 * c for c in tint) + (1,)
    else:
        color, background = tuple(.6 * c for c in tint), tuple(.9 + .1 * c for c in tint) + (1,)

    def apply(name, **inputs):
        f = CIFilter.filterWithName_(name)
        for key, value in inputs.items():
            f.setValue_forKey_(value, key)
        return f.outputImage()
    original = CIImage.imageWithContentsOfURL_(NSURL.fileURLWithPath_(ICON))
    zero = CIVector.vectorWithX_Y_Z_W_(0, 0, 0, 0)
    k = 5.5  # opacity from brightness (linear light, so the green is only ~0.18): green solid, the dark face faint
    glyph = apply("CIColorMatrix", inputImage=original, inputRVector=zero, inputGVector=zero, inputBVector=zero,
                  inputAVector=CIVector.vectorWithX_Y_Z_W_(.299 * k, .587 * k, .114 * k, 0),
                  inputBiasVector=CIVector.vectorWithX_Y_Z_W_(*color, 0))
    glyph = apply("CIColorClamp", inputImage=glyph)
    glyph = apply("CISourceInCompositing", inputImage=glyph, inputBackgroundImage=original)  # keep the soft edges

    rep = NSCIImageRep.imageRepWithCIImage_(glyph)
    glyph_image = NSImage.alloc().initWithSize_(rep.size())
    glyph_image.addRepresentation_(rep)
    image = NSImage.alloc().initWithSize_((1024, 1024))
    image.lockFocus()
    NSColor.colorWithSRGBRed_green_blue_alpha_(*background).setFill()
    NSBezierPath.bezierPathWithRoundedRect_xRadius_yRadius_(NSMakeRect(100, 100, 824, 824), 185, 185).fill()
    glyph_image.drawInRect_fromRect_operation_fraction_(NSMakeRect(90, 90, 844, 844), NSZeroRect,
                                                        NSCompositingOperationSourceOver, 1.0)
    image.unlockFocus()
    return image


def follow_icon_style():
    """Show the tracker's icon in the Dock (started from a script, macOS would show the Python rocket),
    styled like the other apps' icons, and restyle it when Icon & widget style changes (checked every 3 s:
    macOS doesn't announce it)."""
    if sys.platform != "darwin" or not os.path.isfile(ICON):
        return
    from AppKit import NSApplication
    from PyObjCTools import AppHelper

    def show(style):
        NSApplication.sharedApplication().setApplicationIconImage_(styled_icon(*style))

    current = icon_style()
    show(current)

    def watch():
        nonlocal current
        while True:
            time.sleep(3)
            style = icon_style()
            if style != current:
                current = style
                AppHelper.callAfter(show, style)  # AppKit drawing belongs on the main thread
    threading.Thread(target=watch, daemon=True).start()


def silence_unused_keys():
    """A key the page doesn't use (e.g. a letter outside a text field) ends up at the window, and macOS
    plays its "not possible" sound for it. Browsers ignore such keys; so does the app."""
    if sys.platform != "darwin":
        return
    import AppKit
    import objc

    class NSWindow(objc.Category(AppKit.NSWindow)):  # PyObjC wants the category named like the class
        def noResponderFor_(self, selector):
            pass  # instead of the sound


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
    follow_icon_style()
    silence_unused_keys()
    # Not private: the page's saved settings (e.g. the Workflow board open and at full width) survive closing the app.
    webview.start(private_mode=False)
    # The window is closed: returning ends the process, and the server thread with it.
