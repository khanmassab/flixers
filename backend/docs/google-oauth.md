# Fixing Google `redirect_uri_mismatch`

When Google sign-in shows `You can’t sign in because this app sent an invalid request (Error 400: redirect_uri_mismatch)`, the OAuth client in Google Cloud is not configured with the Chrome extension redirect.

## Configure the OAuth client
- Find the extension ID in `chrome://extensions` (enable Developer Mode). It is the `EXT_ID` used in share links like `chrome-extension://<EXT_ID>/popup.html`.
- In Google Cloud Console go to **APIs & Services → Credentials → OAuth 2.0 Client IDs**.
- Create or edit the client used by the extension. Use type **Web application** (or Chrome App if available) and set the authorized redirect URI to `https://<EXT_ID>.chromiumapp.org/` (replace `<EXT_ID>`).
- Save and copy the **Client ID**. Use that exact value both in the extension’s OAuth request and in the backend `GOOGLE_CLIENT_ID` environment variable.
- Restart the backend so `/auth/google` verifies tokens against the updated client ID.

Note: the popup now uses `chrome.identity.getRedirectURL()` to generate the redirect, so if your runtime ID differs per Chrome profile (unpacked installs without a fixed key), you must add the matching redirect URI for each profile’s runtime ID in Google Cloud Console.

## Fixing `Access blocked: Authorization Error (invalid_request)`
When Google still blocks sign-in after the redirect is correct:
- Open Google Cloud Console → **OAuth consent screen**. If status is **Testing**, add your signing-in account under **Test users**, or publish the app to Production.
- Confirm the OAuth client you are using is the one you configured: type **Web application**, same project as the consent screen, and the **Client ID** matches what the extension uses and what the backend has in `GOOGLE_CLIENT_ID`.
- Only keep the redirect URI `https://<EXT_ID>.chromiumapp.org/`; do not add `chrome-extension://…` as an origin (Google rejects it and it is unnecessary).
- Keep scopes to basic `openid email profile`; remove unverified/sensitive scopes unless you have completed verification.
- After any change, save, wait a minute, reload the extension, and retry sign-in.

## Dev fallback
For local/dev usage without Google, leave `GOOGLE_CLIENT_ID` empty. `/auth/google` will accept any token and emit a warning so you can bypass Google while testing.
