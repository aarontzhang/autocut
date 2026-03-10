# TODO

## Per-user storage quota

- Add a 10 GB hard cap per user across all files stored in the Supabase `videos` bucket.
- Track total storage usage by user, including:
  - primary uploaded project videos
  - additional timeline `sources/` uploads
  - additional track `tracks/` uploads
- Warn users before they hit the cap:
  - soft warning at 80%
  - stronger warning at 95%
- Block new uploads once the user would exceed 10 GB.
- Show a clear error telling the user to delete older projects/media to free space.
- Add a user-visible storage usage indicator in the app/dashboard.

## Cleanup correctness

- Ensure project deletion removes all storage objects under the project prefix, not just the primary `video_path`.
- Reconcile storage accounting so deleted projects do not leave orphaned files counted against the user.

## Open implementation questions

- Decide whether usage is computed on demand from bucket contents or cached in the database.
- Decide whether deleted media should be hard-deleted immediately or soft-deleted before cleanup.
- Decide whether quota checks happen only server-side or both client-side and server-side.
