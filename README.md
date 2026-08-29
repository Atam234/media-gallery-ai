# Media Gallery + AI Studio

Full-stack na web app:
- **Pictures & Music gallery** — upload, view, select, delete. Naka-save sa browser (IndexedDB) kaya hindi nawawala kapag nag-refresh.
- **AI Studio tab** — mag-upload ng larawan + prompt, tatawagin ng backend ang **totoong Google AI Studio (Gemini) API** para mag-generate o mag-edit ng imahe.

## Paano ito gumagana

```
Browser (public/index.html + app.js)
   │  FormData: apiKey, prompt, image
   ▼
Node/Express server (server.js)
   │  POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent
   ▼
Google AI Studio (Gemini API)
```

Ang API key ay **hindi naka-hardcode** sa server o sa repo — ikaw mismo ang maglalagay nito sa AI Studio tab (may checkbox kung gusto mong i-save ito sa browser mo lang, hindi ito napupunta sa GitHub).

## 1. Kumuha ng Google AI Studio API Key

1. Pumunta sa https://aistudio.google.com/apikey
2. Mag-sign in gamit ang Google account mo
3. Gumawa ng bagong API key at kopyahin

## 2. Patakbuhin lokal (local testing)

Kailangan: [Node.js](https://nodejs.org) v18 o mas bago.

```bash
npm install
npm start
```

Buksan ang browser sa `http://localhost:3000`.

## 3. I-push sa GitHub

```bash
git init
git add .
git commit -m "Media Gallery + AI Studio"
git branch -M main
git remote add origin https://github.com/USERNAME/REPO-NAME.git
git push -u origin main
```

> Palitan ang `USERNAME/REPO-NAME` ng sarili mong GitHub repo.

## 4. I-deploy ang backend

**Mahalaga:** Ang app na ito ay may live na Node.js server (hindi lang static HTML), kaya **hindi ito gagana sa GitHub Pages** (static files lang ang sinusuportahan doon). Kailangan mo ng host na tumatakbo ng Node — libre ang mga sumusunod:

### Option A: Render.com (recommended, may free tier)
1. Pumunta sa https://render.com at mag-sign in gamit ang GitHub
2. **New +** → **Web Service** → piliin ang repo mo
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Deploy. Makakakuha ka ng URL tulad ng `https://your-app.onrender.com`

### Option B: Railway.app
1. https://railway.app → **New Project** → **Deploy from GitHub repo**
2. Auto-detect ni Railway ang Node app, i-deploy agad
3. Makukuha mo ang live URL sa Settings → Networking

### Option C: Fly.io / Glitch / Cyclic
Kahit alin sa mga ito ay okay basta sinusuportahan nila ang Node.js web services.

Sa lahat ng option, hindi mo kailangang maglagay ng API key sa environment variables ng host — inilalagay ito ng user sa browser mismo, per-request lang ito ginagamit.

## Mga Files

```
media-gallery-ai/
├── server.js          # Express backend, tumatawag sa Gemini API
├── package.json
├── public/
│   ├── index.html      # UI (tabs: Pictures, Music, AI Studio)
│   ├── styles.css
│   └── app.js           # Client logic (IndexedDB storage + AI calls)
└── README.md
```

## Tandaan

- Ang mga larawan at music ay naka-store sa **IndexedDB ng browser mo** — local sa device/browser na ginamit mo mag-upload. Kung ibang device o browser, hindi magkakasama ang laman.
- Ang API key mo ay ikaw lang ang may hawak — huwag itong i-commit sa isang public repo kung sakaling gawin mong environment variable sa hinaharap.
- Ginagamit ang model na `gemini-2.5-flash-image` para sa parehong image generation at image editing (may input image = edit; walang input image = bagong generate).
