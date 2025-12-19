#!/bin/bash
# Package Chrome Extension for distribution

set -e

EXT_DIR="extension"
OUTPUT_DIR="dist"
ZIP_NAME="flixers-extension-v$(grep -o '"version": "[^"]*"' extension/manifest.json | cut -d'"' -f4).zip"

echo "=== Packaging Flixers Extension ==="
echo ""

# Create dist directory
mkdir -p $OUTPUT_DIR

# Create zip file
echo "Creating ZIP file: $ZIP_NAME"
cd $EXT_DIR
zip -r "../$OUTPUT_DIR/$ZIP_NAME" . -x "*.DS_Store" "*.git*" "*.md"
cd ..

echo ""
echo "✅ Extension packaged successfully!"
echo "📦 File: $OUTPUT_DIR/$ZIP_NAME"
echo ""
echo "Next steps:"
echo "1. Go to Chrome Web Store Developer Dashboard: https://chrome.google.com/webstore/devconsole"
echo "2. Click 'New Item'"
echo "3. Upload: $OUTPUT_DIR/$ZIP_NAME"
echo "4. Fill in store listing details"
echo "5. Submit for review"
