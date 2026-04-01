'use client';

import { useEffect, useRef } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';

export function buildProjectEditState(state: ReturnType<typeof useEditorStore.getState>) {
  return {
    clips: state.clips,
    captions: state.captions,
    transitions: state.transitions,
    markers: state.markers,
    textOverlays: state.textOverlays,
    imageOverlays: state.imageOverlays,
    messages: state.messages,
    appliedActions: state.appliedActions,
    backgroundTranscript: state.backgroundTranscript,
    transcriptStatus: state.transcriptStatus,
    transcriptError: state.transcriptError,
    sources: state.sources,
    sourceTranscriptCaptions: state.sourceTranscriptCaptions,
    sourceIndexFreshBySourceId: state.sourceIndexFreshBySourceId,
    sourceIndex: state.sourceIndex,
    videoDuration: state.videoDuration,
    tracks: state.tracks,
  };
}

export async function saveProjectEditState(
  projectId: string,
  state: ReturnType<typeof useEditorStore.getState>,
) {
  const editState = buildProjectEditState(state);
  const res = await fetch(`/api/projects/${projectId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ edit_state: editState }),
  });
  if (!res.ok) {
    throw new Error('Save failed');
  }
}

export function useAutoSave() {
  const clips = useEditorStore(s => s.clips);
  const captions = useEditorStore(s => s.captions);
  const transitions = useEditorStore(s => s.transitions);
  const markers = useEditorStore(s => s.markers);
  const textOverlays = useEditorStore(s => s.textOverlays);
  const imageOverlays = useEditorStore(s => s.imageOverlays);
  const messages = useEditorStore(s => s.messages);
  const appliedActions = useEditorStore(s => s.appliedActions);
  const backgroundTranscript = useEditorStore(s => s.backgroundTranscript);
  const transcriptStatus = useEditorStore(s => s.transcriptStatus);
  const transcriptError = useEditorStore(s => s.transcriptError);
  const sources = useEditorStore(s => s.sources);
  const sourceTranscriptCaptions = useEditorStore(s => s.sourceTranscriptCaptions);
  const sourceIndexFreshBySourceId = useEditorStore(s => s.sourceIndexFreshBySourceId);
  const sourceIndex = useEditorStore(s => s.sourceIndex);
  const videoDuration = useEditorStore(s => s.videoDuration);
  const tracks = useEditorStore(s => s.tracks);
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
        await saveProjectEditState(currentProjectId, state);
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
  }, [clips, captions, transitions, markers, textOverlays, imageOverlays, messages, appliedActions, backgroundTranscript, transcriptStatus, transcriptError, sources, sourceTranscriptCaptions, sourceIndexFreshBySourceId, sourceIndex, videoDuration, tracks, currentProjectId, setSaveStatus]);
}
