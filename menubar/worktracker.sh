#!/bin/bash
# <xbar.title>Work Tracker</xbar.title>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideLastUpdated>true</swiftbar.hideLastUpdated>
# <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>
# SwiftBar plugin: timer in the menu bar, Start/Stop from the menu. No refresh interval: the server
# has SwiftBar re-run it when the text changes (a change, the shown minute flips, a new day), and the
# server writes the menu, so a run is one curl.
URL=http://localhost:47474

case "$1" in  # menu actions: SwiftBar runs this script again with an argument
  start) exec curl -s -o /dev/null -X POST "$URL/api/start" ;;
  stop) exec curl -s -o /dev/null -X POST "$URL/api/stop" ;;
  start-note)
    note=$(osascript -e 'text returned of (display dialog "What are you working on?" default answer "" with title "Work Tracker" buttons {"Cancel", "Start"} default button "Start")') || exit
    note=${note//\\/\\\\}; note=${note//\"/\\\"}; note=${note//$'\t'/ }  # JSON string
    exec curl -s -o /dev/null -X POST -H "Content-Type: application/json" -d "{\"note\": \"$note\"}" "$URL/api/start" ;;
esac

if out=$(curl -sf --max-time 3 "$URL/api/menubar"); then
  printf '%s\n' "${out//@ME@/$0}"
else
  printf '%s\n' "– | sfimage=exclamationmark.triangle" "---" "Work Tracker server is not running" "Retry | refresh=true"
fi
