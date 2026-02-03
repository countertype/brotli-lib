#!/bin/bash
# Compare brotli-lib vs Google's reference brotli CLI

set -e

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

# Generate test data
echo "Generating test data..."
head -c 4500 /dev/urandom | base64 > "$TMPDIR/medium.txt"
cat "$TMPDIR/medium.txt" "$TMPDIR/medium.txt" "$TMPDIR/medium.txt" "$TMPDIR/medium.txt" "$TMPDIR/medium.txt" > "$TMPDIR/large.txt"
cat "$TMPDIR/large.txt" "$TMPDIR/large.txt" "$TMPDIR/large.txt" "$TMPDIR/large.txt" > "$TMPDIR/xlarge.txt"

echo ""
echo "File sizes:"
ls -lh "$TMPDIR"/*.txt | awk '{print "  " $9 ": " $5}'

echo ""
echo "=== Google brotli CLI (quality 11) ==="
for f in medium.txt large.txt xlarge.txt; do
  # Run 5 times and take best
  best=999999
  for i in 1 2 3 4 5; do
    start=$(python3 -c "import time; print(time.time())")
    brotli -q 11 -c "$TMPDIR/$f" > /dev/null
    end=$(python3 -c "import time; print(time.time())")
    elapsed=$(python3 -c "print(int(($end - $start) * 1000))")
    if [ $elapsed -lt $best ]; then best=$elapsed; fi
  done
  echo "  $f: ${best}ms"
done

echo ""
echo "=== Google brotli CLI (quality 5) ==="
for f in medium.txt large.txt xlarge.txt; do
  best=999999
  for i in 1 2 3 4 5; do
    start=$(python3 -c "import time; print(time.time())")
    brotli -q 5 -c "$TMPDIR/$f" > /dev/null
    end=$(python3 -c "import time; print(time.time())")
    elapsed=$(python3 -c "print(int(($end - $start) * 1000))")
    if [ $elapsed -lt $best ]; then best=$elapsed; fi
  done
  echo "  $f: ${best}ms"
done

echo ""
echo "Now run 'npm run bench' to compare with brotli-lib"
