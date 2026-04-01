import posthog from 'posthog-js';

// ─── Type-safe event catalog ────────────────────────────────────────────────

type EventMap = {
  user_signed_up:              { method: 'email' | 'google' };
  user_signed_in:              { method: 'email' | 'google' };
  user_signed_out:             Record<string, never>;

  project_created:             { project_id: string };
  project_opened:              { project_id: string; has_video: boolean };
  project_deleted:             { project_id: string };
  project_renamed:             { project_id: string };

  upload_started:              { file_size_mb: number; duration_s: number };
  upload_completed:            { upload_time_ms: number };
  upload_failed:               { reason: string };

  chat_message_sent:           { message_length: number; has_analysis: boolean; message: string };
  chat_response_received:      { response_time_ms: number; action_type: string | null; has_action: boolean };
  chat_action_applied:         { action_count: number; action_types: string[] };
  chat_action_rejected:        { action_type: string };
  chat_request_failed:         { reason: string };
  chat_quota_hit:              Record<string, never>;
  transcription_started:       Record<string, never>;
  transcription_completed:     { duration_ms: number };
  transcription_failed:        { reason: string };
  frame_descriptions_started:  { frame_count: number };
  frame_descriptions_completed: { frame_count: number; duration_ms: number };

  ai_action_undone:            { action_type: string };
  manual_undo:                 Record<string, never>;
  manual_redo:                 Record<string, never>;

  editor_session_started:      { project_id: string | null };
  editor_session_ended:        { project_id: string | null; duration_s: number };

  subscription_checkout_started: Record<string, never>;
  subscription_checkout_canceled: Record<string, never>;
  subscription_activated:      Record<string, never>;
  subscription_canceled:       Record<string, never>;
  subscription_reactivated:    Record<string, never>;
  billing_portal_opened:       Record<string, never>;

  export_started:              { clip_count: number; total_duration_s: number; has_filters: boolean; has_captions: boolean };
  export_completed:            { duration_ms: number };
  export_failed:               { reason: string };
  export_canceled:             Record<string, never>;
  export_downloaded:           Record<string, never>;

  filter_applied:              { filter_name: string };
  silence_removed:             { silence_count: number };
};

// ─── Guard ───────────────────────────────────────────────────────────────────

const isEnabled = () =>
  typeof window !== 'undefined' &&
  process.env.NODE_ENV === 'production' &&
  Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY);

// ─── Public API ──────────────────────────────────────────────────────────────

export function capture<E extends keyof EventMap>(
  event: E,
  properties: EventMap[E],
): void {
  if (!isEnabled()) return;
  posthog.capture(event, properties as Record<string, unknown>);
}

export function identify(userId: string, traits?: { email?: string }): void {
  if (!isEnabled()) return;
  posthog.identify(userId, traits);
}

export function reset(): void {
  if (!isEnabled()) return;
  posthog.reset();
}
