# PromptLens (Chrome Extension)

## Fixing Google sign-in (`bad client id`)

This extension uses `chrome.identity.getAuthToken()` for Google sign-in. That API **only works** when `manifest.json` has an OAuth Client ID that is configured for **your extension's ID**.

### 1) Get your Extension ID

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Find **PromptLens** and copy the **Extension ID**

### 2) Create the correct OAuth Client ID

In Google Cloud Console (the same project that owns your Firebase project):

1. Go to **APIs & Services -> Credentials**
2. **Create Credentials -> OAuth client ID**
3. Choose **Application type: Chrome Extension** (in some consoles this is named **Chrome App**)
4. Set **Application ID / Item ID** to the Extension ID from step 1
5. Copy the generated **Client ID**

### 3) Update `manifest.json`

Replace `oauth2.client_id` in `manifest.json` with the new Client ID, then reload the extension in `chrome://extensions`.

### Notes for local development

- If you load the extension unpacked from a different folder (or a copied folder), Chrome may assign a different Extension ID, which requires creating a new OAuth Client ID for that new ID.
- Alternatively, you can keep a stable Extension ID by packing the extension with the same key, but **don't commit private keys** to the repo.
