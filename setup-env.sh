#!/bin/bash
# Helper script to set up .env file with generated secrets

set -e

echo "=== Flixers Environment Setup ==="
echo ""

# Check if .env already exists
if [ -f .env ]; then
    echo "⚠️  .env file already exists!"
    read -p "Overwrite? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Cancelled."
        exit 1
    fi
fi

# Generate JWT_SECRET
echo "🔐 Generating JWT_SECRET..."
JWT_SECRET=$(openssl rand -base64 32)
echo "✅ Generated: $JWT_SECRET"
echo ""

# Copy template
cp env.example .env

# Replace JWT_SECRET
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    sed -i '' "s|JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET|" .env
else
    # Linux
    sed -i "s|JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET|" .env
fi

echo "✅ Created .env file with generated JWT_SECRET"
echo ""
echo "📝 Next steps:"
echo "1. Get your Chrome Extension ID:"
echo "   - Load extension unpacked in chrome://extensions"
echo "   - Copy the Extension ID"
echo ""
echo "2. Create Google OAuth Client ID:"
echo "   - Go to: https://console.cloud.google.com/apis/credentials"
echo "   - Create OAuth 2.0 Client ID (Web application)"
echo "   - Add redirect URI: https://<YOUR_EXT_ID>.chromiumapp.org/"
echo "   - Copy the Client ID"
echo ""
echo "3. Update .env file:"
echo "   - Set GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com"
echo "   - Set DB_PASSWORD=your-strong-password"
echo "   - Set ALLOWED_ORIGINS=https://yourdomain.com"
echo ""
echo "4. Update extension files:"
echo "   - extension/popup.js (line 3)"
echo "   - extension/background.js (line 3)"
echo "   - Set GOOGLE_CLIENT_ID to same value"
echo ""
echo "See deploy/SETUP_OAUTH.md for detailed instructions"
