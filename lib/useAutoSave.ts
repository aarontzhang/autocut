'use client';

import { useEffect, useRef } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';

function stripSourceUrl<T extends { sourceUrl?: string }>(item: T): Omit<T, 'sourceUrl'> {
  const copy = { ...item };
  delete copy.sourceUrl;
  return copy;
}

export function useAutoSave() {
  const clips = useEditorStore(s => s.clips);
  const captions = useEditorStore(s => s.captions);
  const transitions = useEditorStore(s => s.transitions);
  const textOverlays = useEditorStore(s => s.textOverlays);
  const extraTracks = useEditorStore(s => s.extraTracks);
  const messages = useEditorStore(s => s.messages);
  const appliedActions = useEditorStore(s => s.appliedActions);
  const aiSettings = useEditorStore(s => s.aiSettings);
  const currentProjectId = useEditorStore(s => s.currentProjectId);
  const setSaveStatus = useEditorStore(s => s.setSaveStatus);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (!currentProjectId) return;

    if (timerRef.current) clearTimeout(timerRef.current);

    setSaveStatus('saving');
    timerRef.current = setTimeout(async () => {
      try {
        const state = useEditorStore.getState();
        const editState = {
          clips: state.clips.map(stripSourceUrl),
          captions: state.captions,
          transitions: state.transitions,
          textOverlays: state.textOverlays,
          messages: state.messages,
          appliedActions: state.appliedActions,
          aiSettings: state.aiSettings,
          extraTracks: state.extraTracks.map(track => ({
            ...track,
            clips: track.clips.map(stripSourceUrl),
          })),
        };
        const res = await fetch(`/api/projects/${currentProjectId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ edit_state: editState }),
        });
        if (!res.ok) throw new Error('Save failed');
        setSaveStatus('saved');
        setTimeout(() => {
          if (useEditorStore.getState().saveStatus === 'saved') {
            setSaveStatus('idle');
          }
        }, 2000);
      } catch {
        setSaveStatus('error');
      }
    }, 1500);

    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [clips, captions, transitions, textOverlays, extraTracks, messages, appliedActions, aiSettings, currentProjectId, setSaveStatus]);
}
