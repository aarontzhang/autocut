# TODO

## Per-user storage quota

- [x] Add a 10 GB hard cap per user across all files stored in the Supabase `videos` bucket.
- [x] Track total storage usage by user, including:
  - primary uploaded project videos
  - additional timeline `sources/` uploads
  - additional track `tracks/` uploads
- [x] Warn users before they hit the cap:
  - soft warning at 80%
  - stronger warning at 95%
- [x] Block new uploads once the user would exceed 10 GB.
- [x] Show a clear error telling the user to delete older projects/media to free space.
- [x] Add a user-visible storage usage indicator in the app/dashboard.

## Cleanup correctness

- [x] Ensure project deletion removes all storage objects under the project prefix, not just the primary `video_path`.
- [x] Reconcile storage accounting so deleted projects do not leave orphaned files counted against the user.

## Open implementation questions

- [x] Usage is computed on demand from bucket contents / storage object metadata.
- Decide whether deleted media should be hard-deleted immediately or soft-deleted before cleanup.
- [x] Quota enforcement happens server-side; warnings/indicators are also surfaced client-side.
- Decide what the landing page should be before sign-up:
  - what users see before creating an account
  - what the product promise is
  - whether users can try anything before signing up
- Decide deployment platform:
  - compare Vercel vs Railway for this app
  - optimize for easiest setup and best fit for the current product stage
  - confirm hosting choice before production launch
