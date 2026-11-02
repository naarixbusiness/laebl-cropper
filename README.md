# Label Cropper

Turns Meesho / Flipkart / Amazon shipping-label PDFs into print-ready A4 sheets: crops just the label (invoices are dropped) and lays out 1–9 labels per page. Everything runs in the browser — no file is ever uploaded.

```bash
npm install
npm run dev       # local development
npm test          # unit tests
npm run build     # builds dist/ — this is what gets hosted
```

## Using it on a phone (with WhatsApp sharing)

Sharing from WhatsApp needs the app on an **HTTPS** site (this repo deploys to Netlify via `netlify.toml`). Then:

1. Open the site in Chrome on the phone → **Install app** (or menu → *Add to Home screen*).
2. In WhatsApp, long-press a label PDF → **Share** → **Label Cropper**.
3. The app opens and adds the PDF to the labels you already have. Sharing the same file twice does not duplicate it.

The share target works on Android Chrome only. On iPhone: in WhatsApp open the PDF → **Share** → **Copy**, then in the app long-press the *Copied a PDF?* box → **Paste**. (On a computer, Ctrl+V / ⌘V anywhere on the page works too.)

Labels are saved in the browser's storage on the device, so they survive closing the app. **Clear everything** removes them.

The platform filter (All / Amazon / Meesho / Flipkart) also decides what is previewed and downloaded.

Keep real label PDFs in `samples/` — that folder is git-ignored.
