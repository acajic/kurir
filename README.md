# Fetch

Share where and when you're driving. Paste a Google Maps directions link (start, destination, time), add a comment, and everyone sees the drive on a map, sorted by day.

## Firebase (recommended if you already use it)

The `firebase/` folder is a complete Firebase project: Hosting serves the page, Firestore stores drives (live for everyone), anonymous sign-in decides who may delete a drive, and the map, location zoom and routes run in the browser.

The project is `kurir-bd9c9` (set in `firebase/.firebaserc`).

1. In the Firebase console: add a Firestore database, and turn on Authentication → Sign-in method → Anonymous.
2. Deploy from your machine: `python3 build.py && cd firebase && npx firebase-tools login && npx firebase-tools deploy --only hosting,firestore`
3. Short maps.app.goo.gl links need the `resolve` Cloud Function, which needs the Blaze plan. On Blaze, deploy with `--only hosting,firestore,functions` (run `npm install` in `firebase/functions` first). Without it, long links still work.
4. Optional automatic deploys: `.github/workflows/firebase-deploy.yml` deploys on every push to main once you add the variable `FIREBASE_PROJECT_ID` (`kurir-bd9c9`) and the secret `FIREBASE_SERVICE_ACCOUNT` in the GitHub repo settings.

## Run your own server instead

- `npm start` runs it on port 8080. Needs Node 22.13+ and has no dependencies. Data lives in SQLite at `$DATA_DIR/fetch.db` (default `./data`).
- Docker: `docker build -t fetch . && docker run -p 8080:8080 -v fetch-data:/data fetch`
- Render: New → Blueprint → pick this repo; `render.yaml` sets up the service and its disk.
- Or host it anywhere else with a persistent disk (a Fly.io volume, a Render disk, any VPS). Serverless hosts like Vercel would lose the database.
- Location and the "Zoom to my area" button need HTTPS.

## Settings (environment variables)

- `PORT` (default 8080), `DATA_DIR` (default `./data`)
- `ROUTER_URL`: OSRM-compatible router used to draw the driving route (default: the public OSRM demo server, fine for light use).
- `NOMINATIM_UA`: user agent for OpenStreetMap Nominatim lookups (municipality zoom). Their policy asks for a contact address in it.

## Layout

- `server.js`: API (drives, routes, short-link resolving, municipality lookup), live updates over server-sent events, static files.
- `src/`: page sources shared by both versions. `parse.js` reads Google Maps directions links.
- `python3 build.py` regenerates `public/index.html` (Node server), `firebase/public/index.html` (Firebase) and `artifact/fetch.html` (the claude.ai Artifact with a schematic map). Edit `src/`, never the generated files.

Google links carry the places and time but not the line Google drew, so the map shows the fastest driving route between the same points.
