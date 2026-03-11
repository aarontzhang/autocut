'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';
import { buildTranscriptContext } from '@/lib/timelineUtils';
import { buildOverlappingRanges, transcribeSourceRanges } from '@/lib/transcriptionUtils';
import TopBar from './TopBar';
import VideoPlayer, { VideoPlayerHandle } from './VideoPlayer';
import MediaPanel from './MediaPanel';
import Timeline from './Timeline';
import ChatSidebar from '../chat/ChatSidebar';
import ExportProgress from './ExportProgress';
import { useAutoSave } from '@/lib/useAutoSave';
import { useAuth } from '@/components/auth/AuthProvider';
import { uploadProjectMedia, createSignedUrls } from '@/lib/projectMedia';
import StorageQuotaBanner from '@/components/storage/StorageQuotaBanner';
import { useStorageQuota } from '@/lib/useStorageQuota';

const SIGNED_MEDIA_REFRESH_INTERVAL_MS = 45 * 60 * 1000;

export default function EditorLayout({ projectId }: { projectId?: string | null } = {}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<VideoPlayerHandle>(null);
  const lastSignedMediaRefreshAtRef = useRef(0);

  // Resizable panel sizes
  const [chatWidth, setChatWidth] = useState(340);
  const [timelineHeight, setTimelineHeight] = useState(300);
  const [mediaPanelWidth, setMediaPanelWidth] = useState(200);
  const [isProjectLoading, setIsProjectLoading] = useState(false);
  const [storageNotice, setStorageNotice] = useState<string | null>(null);

  const startChatResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = chatWidth;
    const onMove = (ev: MouseEvent) => {
      const newW = Math.max(260, Math.min(560, startW + (startX - ev.clientX)));
      setChatWidth(newW);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'ew-resize';
  }, [chatWidth]);

  const startTimelineResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = timelineHeight;
    const onMove = (ev: MouseEvent) => {
      const newH = Math.max(120, Math.min(480, startH + (startY - ev.clientY)));
      setTimelineHeight(newH);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'ns-resize';
  }, [timelineHeight]);

  const startMediaResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = mediaPanelWidth;
    const onMove = (ev: MouseEvent) => {
      const newW = Math.max(140, Math.min(380, startW + (ev.clientX - startX)));
      setMediaPanelWidth(newW);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'ew-resize';
  }, [mediaPanelWidth]);
  const currentTime = useEditorStore(s => s.currentTime);
  const setCurrentTime = useEditorStore(s => s.setCurrentTime);
  const videoFile = useEditorStore(s => s.videoFile);
  const setVideoFile = useEditorStore(s => s.setVideoFile);
  const undo = useEditorStore(s => s.undo);
  const redo = useEditorStore(s => s.redo);
  const deleteSelectedItem = useEditorStore(s => s.deleteSelectedItem);
  const videoDuration = useEditorStore(s => s.videoDuration);
  const transcriptStatus = useEditorStore(s => s.transcriptStatus);
  const setBackgroundTranscript = useEditorStore(s => s.setBackgroundTranscript);
  const setTranscriptProgress = useEditorStore(s => s.setTranscriptProgress);
  const aiSettings = useEditorStore(s => s.aiSettings);
  const loadProject = useEditorStore(s => s.loadProject);
  const resetEditor = useEditorStore(s => s.resetEditor);
  const videoUrl = useEditorStore(s => s.videoUrl);
  const setStoragePath = useEditorStore(s => s.setStoragePath);
  const addMediaLibraryItem = useEditorStore(s => s.addMediaLibraryItem);
  const currentProjectId = useEditorStore(s => s.currentProjectId);
  const { user } = useAuth();
  const { quota, loading: quotaLoading, refresh: refreshQuota } = useStorageQuota(Boolean(user));

  useAutoSave();

  const handleStorageUploadSuccess = useCallback(() => {
    setStorageNotice(null);
    void refreshQuota();
  }, [refreshQuota]);

  const handleStorageUploadError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Upload failed';
    setStorageNotice(message);
  }, []);

  const refreshSignedMediaUrls = useCallback(async (targetProjectId: string) => {
    const state = useEditorStore.getState();
    if (state.currentProjectId !== targetProjectId) return;

    const paths = new Set<string>();
    if (state.storagePath) paths.add(state.storagePath);
    state.mediaLibrary.forEach((item) => {
      if (item.sourcePath) paths.add(item.sourcePath);
    });
    state.clips.forEach((clip) => {
      if (clip.sourcePath) paths.add(clip.sourcePath);
    });
    if (paths.size === 0) return;

    const signedPaths = await createSignedUrls([...paths]);
    if (signedPaths.size === 0 || useEditorStore.getState().currentProjectId !== targetProjectId) return;

    useEditorStore.setState((currentState) => ({
      videoUrl: currentState.storagePath && signedPaths.get(currentState.storagePath)
        ? signedPaths.get(currentState.storagePath)!
        : currentState.videoUrl,
      mediaLibrary: currentState.mediaLibrary.map((item, index) => {
        if (item.sourcePath && signedPaths.get(item.sourcePath)) {
          return { ...item, url: signedPaths.get(item.sourcePath)! };
        }
        if (index === 0 && currentState.storagePath && signedPaths.get(currentState.storagePath)) {
          return { ...item, url: signedPaths.get(currentState.storagePath)! };
        }
        return item;
      }),
      clips: currentState.clips.map((clip) => (
        clip.sourcePath && signedPaths.get(clip.sourcePath)
          ? { ...clip, sourceUrl: signedPaths.get(clip.sourcePath)! }
          : clip
      )),
    }));
    lastSignedMediaRefreshAtRef.current = Date.now();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Allow Cmd/Ctrl+Z (undo) and Cmd/Ctrl+Shift+Z (redo) even when a text input is focused
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && useEditorStore.getState().selectedItem) {
        e.preventDefault();
        deleteSelectedItem();
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        playerRef.current?.togglePlay();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        const t = Math.max(0, currentTime - (e.shiftKey ? 10 : 1));
        playerRef.current?.seekTo(t);
        if (!playerRef.current) {
          setCurrentTime(t);
          if (videoRef.current) videoRef.current.currentTime = t;
        }
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        const dur = videoRef.current?.duration ?? 0;
        const t = Math.min(dur, currentTime + (e.shiftKey ? 10 : 1));
        playerRef.current?.seekTo(t);
        if (!playerRef.current) {
          setCurrentTime(t);
          if (videoRef.current) videoRef.current.currentTime = t;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentTime, setCurrentTime, undo, redo, deleteSelectedItem]);

  // Background auto-transcription on video load
  useEffect(() => {
    const source = videoFile ?? videoUrl;
    if (!source || videoDuration <= 0 || transcriptStatus !== 'idle') return;
    setBackgroundTranscript(null, 'loading');
    setTranscriptProgress({ completed: 0, total: 1 });
    (async () => {
      try {
        const ranges = buildOverlappingRanges(0, videoDuration);
        const rawWords = await transcribeSourceRanges(source, ranges, aiSettings.captions.wordsPerCaption, {
          onProgress: setTranscriptProgress,
        });
        const text = buildTranscriptContext(useEditorStore.getState().clips, rawWords);
        setBackgroundTranscript(text, 'done', rawWords);
      } catch {
        setBackgroundTranscript(null, 'error');
      }
    })();
  }, [aiSettings.captions.wordsPerCaption, videoDuration, transcriptStatus, setBackgroundTranscript, setTranscriptProgress, videoFile, videoUrl]);

  // Load project from URL param
  useEffect(() => {
    if (!projectId) return;
    if (useEditorStore.getState().currentProjectId !== projectId) {
      resetEditor();
    }
    lastSignedMediaRefreshAtRef.current = 0;
    (async () => {
      setIsProjectLoading(true);
      try {
        const res = await fetch(`/api/projects/${projectId}`);
        if (!res.ok) return;
        const data = await res.json();
        const editState = structuredClone(data.edit_state ?? {});
        loadProject(editState, {
          projectId,
          videoUrl: data.signedUrl ?? '',
          storagePath: data.video_path ?? null,
          videoFilename: data.video_filename ?? null,
          signedUrls: data.signedUrls ?? {},
        });
        lastSignedMediaRefreshAtRef.current = Date.now();
        setIsProjectLoading(false);
      } catch (e) {
        console.error('Failed to load project', e);
      } finally {
        setIsProjectLoading(false);
      }
    })();
  }, [loadProject, projectId, refreshSignedMediaUrls, resetEditor]);

  useEffect(() => {
    if (!projectId) return;

    const maybeRefresh = () => {
      if (document.visibilityState !== 'visible') return;
      if (
        lastSignedMediaRefreshAtRef.current > 0
        && Date.now() - lastSignedMediaRefreshAtRef.current < SIGNED_MEDIA_REFRESH_INTERVAL_MS
      ) {
        return;
      }
      void refreshSignedMediaUrls(projectId).catch((error) => {
        console.warn('Failed to refresh signed media URLs:', error);
      });
    };

    const intervalId = window.setInterval(maybeRefresh, SIGNED_MEDIA_REFRESH_INTERVAL_MS);
    window.addEventListener('focus', maybeRefresh);
    document.addEventListener('visibilitychange', maybeRefresh);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', maybeRefresh);
      document.removeEventListener('visibilitychange', maybeRefresh);
    };
  }, [projectId, refreshSignedMediaUrls]);

  const importFile = useCallback((file: File) => {
    if (!file.type.startsWith('video/')) return;
    setVideoFile(file);

    // Background upload to storage so the project persists on reload
    const { currentProjectId, storagePath } = useEditorStore.getState();
    if (!currentProjectId || !user || storagePath) return; // skip if already uploaded
    uploadProjectMedia(file, currentProjectId, 'main').then((path) => {
      setStoragePath(path);
      handleStorageUploadSuccess();
    }).catch((error: Error) => {
      console.warn('Background upload failed:', error.message);
      handleStorageUploadError(error);
    });
  }, [setVideoFile, user, setStoragePath, handleStorageUploadError, handleStorageUploadSuccess]);

  const importLibraryFile = useCallback(async (file: File) => {
    if (!file.type.startsWith('video/')) return;
    const { currentProjectId } = useEditorStore.getState();
    const blobUrl = URL.createObjectURL(file);
    const duration = await new Promise<number>((resolve) => {
      const tmp = document.createElement('video');
      tmp.preload = 'metadata';
      tmp.onloadedmetadata = () => { resolve(tmp.duration); tmp.src = ''; };
      tmp.onerror = () => resolve(0);
      tmp.src = blobUrl;
    });

    let sourcePath: string | undefined;
    if (user && currentProjectId) {
      try {
        sourcePath = await uploadProjectMedia(file, currentProjectId, 'sources');
        handleStorageUploadSuccess();
      } catch (error) {
        console.warn('Library upload failed:', error);
        handleStorageUploadError(error);
      }
    }

    addMediaLibraryItem({ url: blobUrl, name: file.name, duration, sourcePath });
  }, [addMediaLibraryItem, user, handleStorageUploadError, handleStorageUploadSuccess]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) importFile(file);
  }, [importFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const isActiveProjectReady = currentProjectId === projectId;
  const shouldShowProjectLoading = Boolean(projectId) && (isProjectLoading || !isActiveProjectReady);

  return (
    <div
      style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-base)', overflow: 'hidden' }}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      {/* ── Top bar ── */}
      <TopBar onImportFile={importFile} />
      {(storageNotice || quota?.warningLevel === 'warning' || quota?.warningLevel === 'critical' || quota?.warningLevel === 'limit') && (
        <div style={{ padding: '10px 14px 0', flexShrink: 0 }}>
          <StorageQuotaBanner
            quota={quota}
            loading={quotaLoading}
            title="Storage status"
            message={storageNotice}
            compact
          />
        </div>
      )}

      {/* ── Main area below topbar ── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>

        {/* Left: media panel + video + timeline stacked */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>

          {/* Media panel + video preview side by side */}
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
            {/* Media panel */}
            <div style={{ width: mediaPanelWidth, flexShrink: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
              <MediaPanel onImportMainFile={importFile} onImportLibraryFile={importLibraryFile} />
              {/* Media panel resize handle */}
              <div
                onMouseDown={startMediaResize}
                style={{
                  position: 'absolute', top: 0, right: 0, width: 4, height: '100%',
                  cursor: 'ew-resize', zIndex: 10,
                  borderRight: '1px solid var(--border)',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderRightColor = 'rgba(255,255,255,0.25)'; }}
                onMouseLeave={e => { e.currentTarget.style.borderRightColor = 'var(--border)'; }}
              />
            </div>

            {/* Video preview */}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-base)' }}>
              {shouldShowProjectLoading
                ? <ProjectLoadingState />
                : (videoFile || videoUrl)
                ? <VideoPlayer ref={playerRef} videoRef={videoRef} />
                : <EmptyDropZone importFile={importFile} />
              }
            </div>
          </div>

          {/* Timeline resize handle + timeline */}
          <div style={{ flexShrink: 0, position: 'relative' }}>
            <div
              onMouseDown={startTimelineResize}
              style={{
                height: 4, cursor: 'ns-resize',
                borderTop: '1px solid var(--border)',
                background: 'transparent',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderTopColor = 'rgba(255,255,255,0.25)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderTopColor = 'var(--border)'; }}
            />
            <div style={{ height: timelineHeight }}>
              <Timeline
                videoRef={videoRef}
                playerRef={playerRef}
                onImportFile={importFile}
                onStorageUploadError={handleStorageUploadError}
                onStorageUploadSuccess={handleStorageUploadSuccess}
              />
            </div>
          </div>
        </div>

        {/* Chat resize handle + sidebar */}
        <div style={{ display: 'flex', flexShrink: 0, overflow: 'hidden' }}>
          <div
            onMouseDown={startChatResize}
            style={{
              width: 4, height: '100%', cursor: 'ew-resize',
              borderLeft: '1px solid var(--border)',
              background: 'transparent', flexShrink: 0,
            }}
            onMouseEnter={e => { e.currentTarget.style.borderLeftColor = 'rgba(255,255,255,0.25)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderLeftColor = 'var(--border)'; }}
          />
          <div style={{ width: chatWidth, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
            <ChatSidebar />
          </div>
        </div>
      </div>

      <ExportProgress />
    </div>
  );
}

function ProjectLoadingState() {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-base)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, color: 'var(--fg-secondary)' }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: '50%',
            border: '2px solid rgba(255,255,255,0.12)',
            borderTopColor: 'var(--accent)',
            animation: 'spin 0.8s linear infinite',
          }}
        />
        <span style={{ fontSize: 12, fontFamily: 'var(--font-serif)' }}>Loading project...</span>
      </div>
    </div>
  );
}

function EmptyDropZone({ importFile }: { importFile: (f: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-base)' }}>
      <div
        onDragOver={e => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={e => {
          e.preventDefault(); e.stopPropagation(); setIsDragging(false);
          const file = e.dataTransfer.files[0];
          if (file) importFile(file);
        }}
        onClick={() => inputRef.current?.click()}
        style={{
          width: 420,
          border: `1.5px dashed ${isDragging ? 'var(--accent)' : 'rgba(255,255,255,0.12)'}`,
          borderRadius: 10, padding: '48px 32px',
          background: isDragging ? 'var(--accent-dim)' : 'rgba(255,255,255,0.015)',
          cursor: 'pointer', transition: 'all 0.2s ease',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14,
        }}
      >
        <div style={{
          width: 52, height: 52, borderRadius: '50%',
          background: isDragging ? 'var(--accent-dim)' : 'rgba(255,255,255,0.04)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: `1px solid ${isDragging ? 'var(--accent-border)' : 'rgba(255,255,255,0.08)'}`,
          transition: 'all 0.2s ease',
        }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
            stroke={isDragging ? 'var(--accent)' : 'rgba(255,255,255,0.35)'} strokeWidth="1.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
        </div>
        <div style={{ textAlign: 'center' }}>
          <p style={{ fontSize: 15, fontWeight: 500, color: 'var(--fg-primary)', marginBottom: 5 }}>
            {isDragging ? 'Drop to import' : 'Drag & drop your clip'}
          </p>
          <p style={{ fontSize: 13, color: 'var(--fg-secondary)' }}>or click to browse</p>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          {['MP4', 'MOV', 'AVI', 'WEBM', 'MKV'].map(fmt => (
            <span key={fmt} style={{
              fontSize: 10, color: 'var(--fg-muted)',
              padding: '2px 6px',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.07)',
              borderRadius: 3,
            }}>{fmt}</span>
          ))}
        </div>
        <input ref={inputRef} type="file" accept="video/*" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) importFile(f); }} />
      </div>
    </div>
  );
}
