#!/usr/bin/env bash
set -euo pipefail
echo "Installing JS deps…"
npm install
echo "Building program…"
anchor build
echo "Done. Run 'anchor test' to execute the suite."
