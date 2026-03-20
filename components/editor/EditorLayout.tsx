'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';
import type { CaptionEntry } from '@/lib/types';
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
import { MAIN_SOURCE_ID } from '@/lib/sourceUtils';

const SIGNED_MEDIA_REFRESH_INTERVAL_MS = 45 * 60 * 1000;
const MULTI_FILE_NOTICE = 'Capped out at one video for now. Multi-file support coming soon.';
const BLOB_URL_PREFIX = 'blob:';

function isBlobUrl(url: string | undefined | null) {
  return Boolean(url && url.startsWith(BLOB_URL_PREFIX));
}

export default function EditorLayout({ projectId }: { projectId?: string | null } = {}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<VideoPlayerHandle>(null);
  const lastSignedMediaRefreshAtRef = useRef(0);
  const projectLoadSequenceRef = useRef(0);

  const [chatWidth, setChatWidth] = useState(340);
  const [timelineHeight, setTimelineHeight] = useState(300);
  const [mediaPanelWidth, setMediaPanelWidth] = useState(240);
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
      const newW = Math.max(200, Math.min(380, startW + (ev.clientX - startX)));
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
  const videoData = useEditorStore(s => s.videoData);
  const setProjectVideoFile = useEditorStore(s => s.setProjectVideoFile);
  const undo = useEditorStore(s => s.undo);
  const redo = useEditorStore(s => s.redo);
  const deleteSelectedItem = useEditorStore(s => s.deleteSelectedItem);
  const videoDuration = useEditorStore(s => s.videoDuration);
  const setVideoDuration = useEditorStore(s => s.setVideoDuration);
  const transcriptStatus = useEditorStore(s => s.transcriptStatus);
  const setBackgroundTranscript = useEditorStore(s => s.setBackgroundTranscript);
  const setTranscriptProgress = useEditorStore(s => s.setTranscriptProgress);
  const sourceIndexFreshBySourceId = useEditorStore(s => s.sourceIndexFreshBySourceId);
  const playbackActive = useEditorStore(s => s.playbackActive);
  const aiSettings = useEditorStore(s => s.aiSettings);
  const loadProject = useEditorStore(s => s.loadProject);
  const hydrateSourceIndex = useEditorStore(s => s.hydrateSourceIndex);
  const resetEditor = useEditorStore(s => s.resetEditor);
  const videoUrl = useEditorStore(s => s.videoUrl);
  const setStoragePath = useEditorStore(s => s.setStoragePath);
  const currentProjectId = useEditorStore(s => s.currentProjectId);
  const storagePath = useEditorStore(s => s.storagePath);
  const { user } = useAuth();
  const { quota, loading: quotaLoading, refresh: refreshQuota } = useStorageQuota(Boolean(user));

  useAutoSave();

  const hasMainMedia = Boolean(videoFile || videoUrl || storagePath);

  const handleStorageUploadSuccess = useCallback(() => {
    setStorageNotice(null);
    void refreshQuota();
  }, [refreshQuota]);

  const handleStorageUploadError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Upload failed';
    setStorageNotice(message);
  }, []);

  const showSingleSourceNotice = useCallback(() => {
    setStorageNotice(MULTI_FILE_NOTICE);
  }, []);

  const refreshSignedMediaUrl = useCallback(async (targetProjectId: string) => {
    const state = useEditorStore.getState();
    if (state.currentProjectId !== targetProjectId || !state.storagePath) return;
    const signedPaths = await createSignedUrls([state.storagePath]);
    const nextUrl = signedPaths.get(state.storagePath);
    if (!nextUrl) return;

    useEditorStore.setState((currentState) => {
      if (currentState.currentProjectId !== targetProjectId || isBlobUrl(currentState.videoUrl)) {
        return currentState;
      }
      return {
        videoUrl: nextUrl,
      };
    });
    lastSignedMediaRefreshAtRef.current = Date.now();
  }, []);

  const readVideoDuration = useCallback((sourceUrl: string) => (
    new Promise<number>((resolve) => {
      const tmp = document.createElement('video');
      tmp.preload = 'metadata';
      tmp.onloadedmetadata = () => { resolve(tmp.duration); tmp.src = ''; };
      tmp.onerror = () => { resolve(0); tmp.src = ''; };
      tmp.src = sourceUrl;
    })
  ), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
  }, [currentTime, deleteSelectedItem, redo, setCurrentTime, undo]);

  useEffect(() => {
    // Prefer a URL string over a File object so readMediaInput can cache the
    // result across chunks instead of re-reading the entire file from disk
    // on every 45-second segment.
    const source = videoData ?? videoFile ?? videoUrl;
    const isTranscriptFresh = sourceIndexFreshBySourceId[MAIN_SOURCE_ID]?.transcript;
    if (!source || videoDuration <= 0 || isTranscriptFresh || transcriptStatus === 'loading' || transcriptStatus === 'error' || document.hidden || playbackActive) {
      return;
    }
    const ranges = buildOverlappingRanges(0, videoDuration);
    setBackgroundTranscript(useEditorStore.getState().backgroundTranscript, 'loading');
    setTranscriptProgress({ completed: 0, total: Math.max(ranges.length, 1) });
    (async () => {
      try {
        const rawWords: CaptionEntry[] = await transcribeSourceRanges(
          source,
          ranges,
          aiSettings.captions.wordsPerCaption,
          {
            sourceId: MAIN_SOURCE_ID,
            onProgress: (progress) => {
              setTranscriptProgress(progress);
            },
          },
        );
        setBackgroundTranscript(useEditorStore.getState().backgroundTranscript, 'done', rawWords);
      } catch (error) {
        console.warn('Background transcription failed:', error);
        setBackgroundTranscript(
          null,
          'error',
          undefined,
          error instanceof Error ? error.message : 'Audio transcription did not finish.',
        );
      }
    })();
  }, [aiSettings.captions.wordsPerCaption, playbackActive, setBackgroundTranscript, setTranscriptProgress, sourceIndexFreshBySourceId, transcriptStatus, videoData, videoDuration, videoFile, videoUrl]);

  useEffect(() => {
    if (!projectId) return;
    if (useEditorStore.getState().currentProjectId !== projectId) {
      resetEditor();
    }
    lastSignedMediaRefreshAtRef.current = 0;
    const loadSequence = projectLoadSequenceRef.current + 1;
    projectLoadSequenceRef.current = loadSequence;
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
          duration: typeof data.duration === 'number' ? data.duration : undefined,
        });
        if (projectLoadSequenceRef.current !== loadSequence) return;
        try {
          const sourceIndexRes = await fetch(`/api/projects/${projectId}/source-index`);
          if (sourceIndexRes.ok) {
            const sourceIndexData = await sourceIndexRes.json();
            if (projectLoadSequenceRef.current === loadSequence) {
              hydrateSourceIndex({
                sourceTranscriptCaptions: Array.isArray(sourceIndexData?.sourceTranscriptCaptions)
                  ? sourceIndexData.sourceTranscriptCaptions
                  : null,
                sourceOverviewFrames: Array.isArray(sourceIndexData?.sourceOverviewFrames)
                  ? sourceIndexData.sourceOverviewFrames
                  : null,
                sourceIndexFreshBySourceId: sourceIndexData?.sourceIndexFreshBySourceId ?? undefined,
              });
            }
          }
        } catch (error) {
          console.warn('Failed to hydrate source index:', error);
        }
        lastSignedMediaRefreshAtRef.current = Date.now();
      } catch (e) {
        console.error('Failed to load project', e);
      } finally {
        if (projectLoadSequenceRef.current === loadSequence) {
          setIsProjectLoading(false);
        }
      }
    })();
  }, [hydrateSourceIndex, loadProject, projectId, resetEditor]);

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
      void refreshSignedMediaUrl(projectId).catch((error) => {
        console.warn('Failed to refresh signed media URL:', error);
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
  }, [projectId, refreshSignedMediaUrl]);

  const importMainFile = useCallback(async (file: File) => {
    if (!file.type.startsWith('video/')) return;
    if (hasMainMedia) {
      showSingleSourceNotice();
      return;
    }
    const targetProjectId = useEditorStore.getState().currentProjectId ?? projectId;
    if (!targetProjectId) return;

    const blobUrl = URL.createObjectURL(file);
    const duration = await readVideoDuration(blobUrl);
    URL.revokeObjectURL(blobUrl);

    if (duration > 30 * 60) {
      setStorageNotice('Videos over 30 minutes are not supported yet. Please trim or split the video first.');
      return;
    }

    setProjectVideoFile(file, targetProjectId);
    if (duration > 0) {
      setVideoDuration(duration);
    }

    const { currentProjectId, storagePath: currentStoragePath } = useEditorStore.getState();
    if (!currentProjectId || !user || currentStoragePath) return;
    uploadProjectMedia(file, currentProjectId, 'main').then((path) => {
      setStoragePath(path);
      handleStorageUploadSuccess();
    }).catch((error: Error) => {
      console.warn('Background upload failed:', error.message);
      handleStorageUploadError(error);
    });
  }, [handleStorageUploadError, handleStorageUploadSuccess, hasMainMedia, projectId, readVideoDuration, setProjectVideoFile, setStoragePath, setStorageNotice, setVideoDuration, showSingleSourceNotice, user]);

  const importFiles = useCallback(async (files: File[]) => {
    const videoFiles = files.filter((file) => file.type.startsWith('video/'));
    if (videoFiles.length === 0) return;
    if (hasMainMedia) {
      showSingleSourceNotice();
      return;
    }
    await importMainFile(videoFiles[0]);
    if (videoFiles.length > 1) {
      showSingleSourceNotice();
    }
  }, [hasMainMedia, importMainFile, showSingleSourceNotice]);

  const handleRootDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (hasMainMedia) {
      showSingleSourceNotice();
      return;
    }
    void importFiles(Array.from(e.dataTransfer.files));
  }, [hasMainMedia, importFiles, showSingleSourceNotice]);

  const handleRootDragOver = useCallback((e: React.DragEvent) => {
    if (!hasMainMedia) {
      e.preventDefault();
    }
  }, [hasMainMedia]);

  const isActiveProjectReady = currentProjectId === projectId;
  const shouldShowProjectLoading = Boolean(projectId) && (isProjectLoading || !isActiveProjectReady);

  return (
    <div
      style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-base)', overflow: 'hidden' }}
      onDrop={!hasMainMedia ? handleRootDrop : undefined}
      onDragOver={!hasMainMedia ? handleRootDragOver : undefined}
    >
      <TopBar />
      {(storageNotice || quota?.warningLevel === 'warning' || quota?.warningLevel === 'critical' || quota?.warningLevel === 'limit') && (
        <div style={{ padding: '10px 14px 0', flexShrink: 0 }}>
          <StorageQuotaBanner
            quota={quota}
            loading={quotaLoading}
            title="Storage status"
            message={storageNotice}
            compact
            showUsageSummary={!storageNotice}
          />
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
            <div style={{ width: mediaPanelWidth, flexShrink: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
              <MediaPanel
                onImportMainFile={importMainFile}
                canImport={!hasMainMedia}
              />
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

            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-base)' }}>
              {shouldShowProjectLoading
                ? <ProjectLoadingState />
                : hasMainMedia
                  ? <VideoPlayer ref={playerRef} videoRef={videoRef} />
                  : <EmptyDropZone importFiles={importFiles} />
              }
            </div>
          </div>

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
              />
            </div>
          </div>
        </div>

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

function EmptyDropZone({
  importFiles,
}: {
  importFiles: (files: File[]) => void | Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-base)' }}>
      <div
        onDragOver={e => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={e => {
          e.preventDefault();
          e.stopPropagation();
          setIsDragging(false);
          void importFiles(Array.from(e.dataTransfer.files));
        }}
        onClick={() => inputRef.current?.click()}
        style={{
          width: 460,
          maxWidth: 'calc(100% - 32px)',
          border: `1.5px dashed ${isDragging ? 'var(--accent)' : 'rgba(255,255,255,0.12)'}`,
          borderRadius: 10,
          padding: '48px 32px',
          background: isDragging ? 'var(--accent-dim)' : 'rgba(255,255,255,0.015)',
          cursor: 'pointer',
          transition: 'all 0.2s ease',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 14,
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
            {isDragging ? 'Drop your video' : 'Import video'}
          </p>
          <p style={{ fontSize: 13, color: 'var(--fg-secondary)' }}>Drag & drop or click to browse</p>
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
        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          style={{ display: 'none' }}
          onChange={e => {
            void importFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
