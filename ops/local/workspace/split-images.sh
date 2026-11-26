#!/usr/bin/env sh
# Splits this folder's tmrkz-images.tar into 100 MB parts for a transfer that may break off (ADR-107: through PAM the 1 GB file
# arrived cut at 414 MB and «docker load» stopped with «short read … unexpected EOF»). A part that arrives damaged is named by
# its checksum and only that part is sent again. start.sh loads the parts directly (no joined copy is written on the server).
#   sh ops/local/workspace/split-images.sh <destination folder>
# writes there: tmrkz-images.tar.part-00 … , tmrkz-images.tar.parts.sha256 (one line per part) and tmrkz-images.tar.sha256 (the
# whole archive). By hand on the server, instead of start.sh:
#   sha256sum -c tmrkz-images.tar.parts.sha256 && cat tmrkz-images.tar.part-* | docker load
set -eu
cd "$(dirname "$0")/../../.."
DEST="${1:?usage: sh ops/local/workspace/split-images.sh <destination folder>}"
SIZE="${TMRKZ_IMAGE_PART_MB:-100}"
[ -s tmrkz-images.tar ] && [ -s tmrkz-images.tar.sha256 ] || { echo "tmrkz-images.tar and its .sha256 are needed (pack-images.sh)"; exit 1; }
sha() { (sha256sum "$@" 2>/dev/null || shasum -a 256 "$@") | sed 's/ \*/  /'; }
echo "  checking tmrkz-images.tar …"
sha256sum -c tmrkz-images.tar.sha256 >/dev/null 2>&1 || shasum -a 256 -c tmrkz-images.tar.sha256 >/dev/null || { echo "tmrkz-images.tar does not match its checksum"; exit 1; }
mkdir -p "$DEST"
rm -f "$DEST"/tmrkz-images.tar.part-* "$DEST/tmrkz-images.tar.parts.sha256"
split -b "${SIZE}m" -d -a 2 tmrkz-images.tar "$DEST/tmrkz-images.tar.part-"
cp tmrkz-images.tar.sha256 "$DEST/tmrkz-images.tar.sha256"
(cd "$DEST" && sha tmrkz-images.tar.part-* > tmrkz-images.tar.parts.sha256)
# proof: the parts in order are the archive
whole="$(cut -d' ' -f1 tmrkz-images.tar.sha256)"
joined="$(cat "$DEST"/tmrkz-images.tar.part-* | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1)"
[ "$whole" = "$joined" ] || { echo "the parts do not join to tmrkz-images.tar"; exit 1; }
echo "  $(ls "$DEST"/tmrkz-images.tar.part-* | wc -l | tr -d ' ') parts of ${SIZE} MB in $DEST; joined they match tmrkz-images.tar ($whole)"
