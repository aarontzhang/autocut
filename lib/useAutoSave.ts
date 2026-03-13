'use client';

import { useEffect, useRef } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';

function persistOverviewFrame(frame: {
  timelineTime: number;
  sourceTime: number;
  sourceId?: string;
  kind: string;
  description?: string;
}) {
  return {
    timelineTime: frame.timelineTime,
    sourceTime: frame.sourceTime,
    ...(frame.sourceId ? { sourceId: frame.sourceId } : {}),
    kind: frame.kind,
    description: frame.description ?? '',
  };
}

function stripSourceUrl<T extends { sourceUrl?: string }>(item: T): Omit<T, 'sourceUrl'> {
  const copy = { ...item };
  delete copy.sourceUrl;
  return copy;
}

function persistMediaLibraryItem(item: {
  name: string;
  duration: number;
  sourceId?: string;
  sourcePath?: string;
}) {
  return {
    name: item.name,
    duration: item.duration,
    ...(item.sourceId ? { sourceId: item.sourceId } : {}),
    ...(item.sourcePath ? { sourcePath: item.sourcePath } : {}),
  };
}

export function useAutoSave() {
  const clips = useEditorStore(s => s.clips);
  const captions = useEditorStore(s => s.captions);
  const transitions = useEditorStore(s => s.transitions);
  const markers = useEditorStore(s => s.markers);
  const textOverlays = useEditorStore(s => s.textOverlays);
  const messages = useEditorStore(s => s.messages);
  const appliedActions = useEditorStore(s => s.appliedActions);
  const aiSettings = useEditorStore(s => s.aiSettings);
  const backgroundTranscript = useEditorStore(s => s.backgroundTranscript);
  const transcriptStatus = useEditorStore(s => s.transcriptStatus);
  const rawTranscriptCaptions = useEditorStore(s => s.rawTranscriptCaptions);
  const videoFrames = useEditorStore(s => s.videoFrames);
  const videoFramesFresh = useEditorStore(s => s.videoFramesFresh);
  const currentProjectId = useEditorStore(s => s.currentProjectId);
  const mediaLibrary = useEditorStore(s => s.mediaLibrary);
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
          markers: state.markers,
          textOverlays: state.textOverlays,
          messages: state.messages,
          appliedActions: state.appliedActions,
          aiSettings: state.aiSettings,
          backgroundTranscript: state.backgroundTranscript,
          transcriptStatus: state.transcriptStatus,
          rawTranscriptCaptions: state.rawTranscriptCaptions,
          videoFrames: state.videoFramesFresh
            ? (state.videoFrames ?? [])
                .filter(frame => frame.kind === 'overview' && !!frame.description?.trim())
                .map(persistOverviewFrame)
            : null,
          mediaLibrary: state.mediaLibrary
            .filter(item => item.sourcePath)
            .map(persistMediaLibraryItem),
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
  }, [clips, captions, transitions, markers, textOverlays, messages, appliedActions, aiSettings, backgroundTranscript, transcriptStatus, rawTranscriptCaptions, videoFrames, videoFramesFresh, currentProjectId, mediaLibrary, setSaveStatus]);
}
