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

The share target works on Android Chrome only. iPhone (Safari, Chrome and home-screen apps all run on WebKit) never lets a web page receive a copied PDF file — only images — so on iPhone:

- **With a Shortcut (one-time setup):** in the Shortcuts app create *Label Cropper* → *Show in Share Sheet* (receive **PDFs**) → **Base64 Encode** (Line Breaks: None) → **Combine Text** (New Lines) → **Copy to Clipboard**. Then WhatsApp → PDF → **Share** → **Label Cropper**, open the app → **Paste PDF**. The app decodes the text back into the original PDF. The full steps are in the app under *How to send PDFs here?*.
- **Without setup:** WhatsApp → **Share** → **Save to Files**, then **Select label PDFs** → *Recents*.

On a computer, Ctrl+V / ⌘V of a copied PDF file (or of base64 PDF text) anywhere on the page works too.

Labels are saved in the browser's storage on the device, so they survive closing the app. **Clear everything** removes them.

The platform filter (All / Amazon / Meesho / Flipkart) also decides what is previewed and downloaded.

## Order IDs: duplicates and print history

Each label's order ID is read from the PDF (Meesho sub-order `…_1`, Flipkart `OD…` + AWB, Amazon order number from the invoice beside the label) and shown on its card.

- **Duplicates** — the same order loaded twice (in one PDF or across PDFs) is printed once; later copies are tagged *Duplicate*.
- **Print history** — every Download/Share saves the included orders as printed. When they turn up again they're tagged *Printed · date*. *Include already printed labels* (Print settings) decides whether they go into the PDF; to reprint one torn label, just switch that card on. **Clear history** forgets them all.
- A label whose order ID can't be read with certainty shows *No order ID found* and is never merged or marked printed.

History is stored on the device only (each browser / installed app has its own).

Keep real label PDFs in `samples/` — that folder is git-ignored.
