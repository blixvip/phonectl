#!/usr/bin/env bash
# Rebuild icondump.dex (only needed if IconDump.java changes).
set -euo pipefail
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-$LOCALAPPDATA/Android/Sdk}"
JAR="$(ls -d "$SDK"/platforms/android-* | sort -V | tail -1)/android.jar"
BT="$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)"; D8="$BT/d8"; [ -f "$D8.bat" ] && D8="$D8.bat"
rm -rf classes && mkdir classes
javac --release 11 -cp "$JAR" -d classes IconDump.java
"$D8" --release --min-api 26 --lib "$JAR" --output . classes/IconDump.class
mv classes.dex icondump.dex
rm -rf classes
echo "built $(pwd)/icondump.dex"
