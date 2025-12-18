# Setting Up Google OAuth Client ID

## Step 1: Get Your Chrome Extension ID

1. **Load your extension unpacked:**
   - Open Chrome and go to `chrome://extensions`
   - Enable "Developer mode" (toggle in top right)
   - Click "Load unpacked"
   - Select your `extension/` folder

2. **Copy your Extension ID:**
   - Find it on the extension card (e.g., `abcdefghijklmnopqrstuvwxyz123456`)
   - Or check the URL when you click the extension: `chrome-extension://<EXT_ID>/popup.html`

## Step 2: Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click "Select a project" → "New Project"
3. Name it "Flixers" (or your preferred name)
4. Click "Create"

## Step 3: Configure OAuth Consent Screen

1. In Google Cloud Console, go to **APIs & Services → OAuth consent screen**
2. Choose **External** (unless you have Google Workspace)
3. Fill in:
   - **App name**: `Flixers Watch Party`
   - **User support email**: Your email
   - **Developer contact information**: Your email
4. Click **Save and Continue**
5. **Scopes**: Click "Add or Remove Scopes"
   - Add: `openid`, `email`, `profile`
   - Click "Update" → "Save and Continue"
6. **Test users** (if in Testing mode):
   - Add your Google account email
   - Click "Save and Continue"
7. Click "Back to Dashboard"

## Step 4: Create OAuth 2.0 Client ID

1. Go to **APIs & Services → Credentials**
2. Click **+ CREATE CREDENTIALS** → **OAuth 2.0 Client ID**
3. If prompted, configure consent screen (follow Step 3 above)
4. **Application type**: Select **Web application**
5. **Name**: `Flixers Extension`
6. **Authorized redirect URIs**: Click **+ ADD URI**
   - Enter: `https://<YOUR_EXT_ID>.chromiumapp.org/`
   - Replace `<YOUR_EXT_ID>` with your actual Extension ID from Step 1
   - Example: `https://abcdefghijklmnopqrstuvwxyz123456.chromiumapp.org/`
7. Click **CREATE**
8. **Copy the Client ID** (looks like: `400373504190-xxxxx.apps.googleusercontent.com`)
   - ⚠️ **Save this!** You'll need it for both extension and backend

## Step 5: Update Your Code

### Update Extension Files

Update these files with your Client ID:

**`extension/popup.js`** (line 3):
```javascript
const GOOGLE_CLIENT_ID = "your-client-id-here.apps.googleusercontent.com";
```

**`extension/background.js`** (line 3):
```javascript
const GOOGLE_CLIENT_ID = "your-client-id-here.apps.googleusercontent.com";
```

### Update Backend `.env` File

Create `.env` file (copy from `env.example`):
```bash
cp env.example .env
```

Add your Client ID:
```bash
GOOGLE_CLIENT_ID=your-client-id-here.apps.googleusercontent.com
```

## Step 6: Test Authentication

1. **Reload your extension** in Chrome (`chrome://extensions` → reload icon)
2. **Restart your backend** (if running)
3. **Test sign-in**:
   - Click your extension icon
   - Click "Sign in with Google"
   - You should see Google OAuth screen
   - After signing in, you should be authenticated

## Troubleshooting

### Error: `redirect_uri_mismatch`
- **Fix**: Make sure the redirect URI in Google Cloud Console exactly matches:
  - `https://<YOUR_EXT_ID>.chromiumapp.org/`
- **Note**: Extension ID changes for unpacked extensions per Chrome profile
- **Solution**: Add redirect URI for each Extension ID you use

### Error: `Access blocked: Authorization Error`
- **Fix**: Add your Google account as a "Test user" in OAuth consent screen
- Or publish the OAuth consent screen to Production (requires verification)

### Extension ID keeps changing
- **Fix**: This happens with unpacked extensions
- **Solution**: After publishing to Chrome Web Store, Extension ID becomes permanent
- For now, add all Extension IDs you use to the redirect URIs

## Quick Reference

- **Extension ID**: Found in `chrome://extensions` (Developer mode enabled)
- **Redirect URI Format**: `https://<EXT_ID>.chromiumapp.org/`
- **Client ID Format**: `xxxxx-xxxxx.apps.googleusercontent.com`
- **Where to use**: Extension code (`popup.js`, `background.js`) + Backend `.env`
