# Autocut — TODO

## Blocked: Supabase Storage Issue
- Video uploads are silently failing (no console errors)
- Supabase billing upgrade is also stuck loading
- Resume once Supabase support responds

---

## Multi-Project / Dashboard Flow

### 1. Fix upload persistence (blocked by Supabase)
- After upload, URL should update to `/?project=<id>` (code already done)
- On reload, app should re-fetch video from Supabase Storage and restore edits

### 2. Project Dashboard (`/projects`) [done]
- Already has `ProjectDashboard` component and `/projects` page
- Show list of user's projects (name, date, video filename)
- Each project card: click to open, delete button
- "New Project" button → goes to upload screen
- After login, redirect to `/projects` instead of directly to editor

### 3. User Profile Dropdown [done]
- Replace the "Sign out" button with a dropdown
- Show: profile picture / email, auth method (Google, email)
- Options: "Go to Dashboard", "Sign out"

### 4. Post-login redirect [done]
- After Google/email login, send user to `/projects` dashboard
- Currently sends to `/` (editor) directly

---

## Nice to Have (later)
- Project thumbnails (first frame of video)
- Rename projects inline
- Sort/filter projects by date or name

---

## Review Edits UI

[done] Multi-step AI edits now open a review flow with preview, per-step Apply/Skip, and a final commit after review.

When the AI proposes an edit (cuts, trims, deletes, etc.), the user should step through each individual change one at a time and accept or reject it before anything is applied — like how Claude Code shows each file diff before committing.

Right now "Accept" applies everything at once, which is meaningless for multi-step edits. Instead:

- Each proposed change (cut segment, trim clip, delete range, etc.) appears as a discrete step
- User clicks **Apply** or **Skip** on each one individually, seeing a preview of exactly what will change in the timeline
- Only accepted changes get applied; skipped ones are discarded
- After all steps are reviewed, the final edit state is committed
