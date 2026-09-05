# QA Video Site - 6 Projects / 60 Questions

This version uses one static frontend, one Render backend, and Supabase PostgreSQL + Storage.

## Projects
1. PRAGATI
2. SHOONYA AVKASHA
3. SOHAM
4. MUKTI
5. BHAKTI
6. AARYA-X

Each project has 10 question slots, for 60 total questions/videos.

## Frontend
Cloudflare Pages should deploy the `frontend` directory.
Edit `frontend/config.js` only if the Render API URL changes.

## Render backend
Root directory: `backend`
Build command: `npm install`
Start command: `npm start`
Environment variables:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ADMIN_TOKEN`
- `SUPABASE_BUCKET=qa-videos`
- `MAX_VIDEO_MB=50`
- `FRONTEND_URL=https://YOUR-CLOUDFLARE-DOMAIN.pages.dev`

## Supabase
Run `supabase/schema.sql` in Supabase SQL Editor before the new Render deployment.
The backend uses the service-role key only on Render. Never put that key in frontend/config.js.

## Admin upload workflow
Open `admin.html`, log in with ADMIN_TOKEN, choose one of the six projects, and use the 10 question cards.
Each card accepts a question, optional note, and video. Existing cards can replace their video or delete the question/video.

## Display workflow
Open `index.html`. Choose a project from the dropdown. The page loads only that project's questions and video URLs.
The page retries failed API calls up to three times and caches the last successfully loaded project in the browser.
A screen can optionally be assigned a project by opening `index.html?project=1` through `?project=6`.

## UptimeRobot
Monitor:
`https://qa-video-site.onrender.com/health`
Recommended interval: 5 minutes.
This reduces idle-sleep risk but does not guarantee continuous uptime on a free Render service.
