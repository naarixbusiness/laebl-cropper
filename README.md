# Label Cropper

Meesho / Flipkart / Amazon shipping label PDF → fakt label crop → A4 sheet (1 thi 9 per page). Badhu phone/browser ma j thay chhe, koi file upload nathi thati.

```bash
npm install
npm run dev       # computer par develop karva
npm test          # unit tests
npm run build     # dist/ folder banave — aa j host karvanu
```

## Phone par vaparvu (WhatsApp share sathe)

WhatsApp mathi "Share" karva mate app ne **HTTPS** website par mukvi pade (Netlify, Vercel, GitHub Pages, Cloudflare Pages — `dist/` folder upload karo). Pachhi:

1. Phone na Chrome ma website kholo → **Install app** (athva menu → *Add to Home screen*).
2. WhatsApp ma label PDF par long-press → **Share** → **Label Cropper**.
3. App khulse ane PDF juna labels sathe umerai jase. Ek j file be var aave to duplicate nahi thay.

Share target fakt Android Chrome ma chale chhe; iPhone par app ma "+ Vadhu PDF umero" thi file pasand karo.

Labels phone na browser storage ma save rahe chhe — app band kari ne kholo to pan rahe. **Badhu clear karo** thi j jay.

Real label PDFs `samples/` ma rakho — aa folder git ma nathi jatu.
