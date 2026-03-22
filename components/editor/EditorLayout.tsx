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
import { saveProjectEditState, useAutoSave } from '@/lib/useAutoSave';
import { useAuth } from '@/components/auth/AuthProvider';
import { createSignedUrls, uploadProjectMedia } from '@/lib/projectMedia';
import StorageQuotaBanner from '@/components/storage/StorageQuotaBanner';
import { useStorageQuota } from '@/lib/useStorageQuota';
import { MAIN_SOURCE_ID } from '@/lib/sourceUtils';
import { resolvePrimaryProjectSource } from '@/lib/sourceMedia';

const SIGNED_MEDIA_REFRESH_INTERVAL_MS = 45 * 60 * 1000;
const SOURCE_INDEX_POLL_INTERVAL_MS = 4000;

export default function EditorLayout({ projectId }: { projectId?: string | null } = {}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<VideoPlayerHandle>(null);
  const lastSignedMediaRefreshAtRef = useRef(0);
  const projectLoadSequenceRef = useRef(0);
  const projectSyncQueueRef = useRef(Promise.resolve());

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
  const sources = useEditorStore(s => s.sources);
  const sourceRuntimeById = useEditorStore(s => s.sourceRuntimeById);
  const importSourceDrafts = useEditorStore(s => s.importSources);
  const updateSource = useEditorStore(s => s.updateSource);
  const updateSourceRuntime = useEditorStore(s => s.updateSourceRuntime);
  const undo = useEditorStore(s => s.undo);
  const redo = useEditorStore(s => s.redo);
  const deleteSelectedItem = useEditorStore(s => s.deleteSelectedItem);
  const videoDuration = useEditorStore(s => s.videoDuration);
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
  const processingVideoUrl = useEditorStore(s => s.processingVideoUrl);
  const currentProjectId = useEditorStore(s => s.currentProjectId);
  const { user } = useAuth();
  const { quota, loading: quotaLoading, refresh: refreshQuota } = useStorageQuota(Boolean(user));

  const refreshSourceIndex = useCallback(async (targetProjectId: string) => {
    const sourceIndexRes = await fetch(`/api/projects/${targetProjectId}/source-index`, { cache: 'no-store' });
    if (!sourceIndexRes.ok) return null;
    const sourceIndexData = await sourceIndexRes.json();
    if (Array.isArray(sourceIndexData?.sources)) {
      for (const source of sourceIndexData.sources) {
        if (typeof source?.id !== 'string') continue;
        updateSource(source.id, {
          storagePath: typeof source.storagePath === 'string' ? source.storagePath : null,
          assetId: typeof source.assetId === 'string' ? source.assetId : null,
          duration: typeof source.duration === 'number' ? source.duration : undefined,
          status: source.status,
        });
      }
    }
    hydrateSourceIndex({
      sourceTranscriptCaptions: Array.isArray(sourceIndexData?.sourceTranscriptCaptions)
        ? sourceIndexData.sourceTranscriptCaptions
        : null,
      sourceOverviewFrames: Array.isArray(sourceIndexData?.sourceOverviewFrames)
        ? sourceIndexData.sourceOverviewFrames
        : null,
      sourceIndexFreshBySourceId: sourceIndexData?.sourceIndexFreshBySourceId ?? undefined,
      analysis: sourceIndexData?.analysis ?? null,
    });
    return sourceIndexData;
  }, [hydrateSourceIndex, updateSource]);

  const queueProjectStateSync = useCallback((targetProjectId: string) => {
    projectSyncQueueRef.current = projectSyncQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        await saveProjectEditState(targetProjectId, useEditorStore.getState());
        await refreshSourceIndex(targetProjectId);
      })
      .catch((error) => {
        console.warn('Failed to sync project sources:', error);
      });

    return projectSyncQueueRef.current;
  }, [refreshSourceIndex]);

  useAutoSave();

  const hasSources = sources.length > 0;

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
    const sourcesWithStorage = state.sources.filter((source) => source.storagePath);
    if (sourcesWithStorage.length === 0) return;

    const signedPaths = await createSignedUrls(sourcesWithStorage.map((source) => source.storagePath!));
    for (const source of sourcesWithStorage) {
      const processingUrl = signedPaths.get(source.storagePath!) ?? '';
      updateSourceRuntime(source.id, {
        playerUrl: `/api/projects/${targetProjectId}/media?sourceId=${encodeURIComponent(source.id)}`,
        processingUrl,
      });
    }
    lastSignedMediaRefreshAtRef.current = Date.now();
  }, [updateSourceRuntime]);

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
    const primarySource = resolvePrimaryProjectSource({
      sources,
      runtimeBySourceId: sourceRuntimeById,
      primaryFallback: {
        videoData,
        videoFile,
        videoUrl,
        processingVideoUrl,
        videoDuration,
      },
    });
    const source = primarySource?.source ?? null;
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
  }, [aiSettings.captions.wordsPerCaption, playbackActive, processingVideoUrl, setBackgroundTranscript, setTranscriptProgress, sourceIndexFreshBySourceId, sourceRuntimeById, sources, transcriptStatus, videoData, videoDuration, videoFile, videoUrl]);

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
          processingVideoUrl: data.processingUrl ?? data.signedUrl ?? '',
          storagePath: data.video_path ?? null,
          videoFilename: data.video_filename ?? null,
          duration: typeof data.duration === 'number' ? data.duration : undefined,
          sources: Array.isArray(data.sources) ? data.sources : undefined,
        });
        if (projectLoadSequenceRef.current !== loadSequence) return;
        try {
          await refreshSignedMediaUrls(projectId);
          const sourceIndexData = await refreshSourceIndex(projectId);
          if (projectLoadSequenceRef.current !== loadSequence || !sourceIndexData) {
            return;
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
  }, [loadProject, projectId, refreshSignedMediaUrls, refreshSourceIndex, resetEditor]);

  useEffect(() => {
    if (!projectId) return;

    let cancelled = false;
    let intervalId: number | null = null;

    const refresh = async () => {
      try {
        const sourceIndexData = await refreshSourceIndex(projectId);
        const status = sourceIndexData?.analysis?.status;
        const hasPendingIndexedSources = Array.isArray(sourceIndexData?.sources)
          && sourceIndexData.sources.some((source: { status?: unknown }) => (
            source?.status === 'pending' || source?.status === 'indexing'
          ));
        if (!cancelled && (status === 'queued' || status === 'running' || hasPendingIndexedSources)) {
          if (intervalId === null) {
            intervalId = window.setInterval(() => {
              void refresh();
            }, SOURCE_INDEX_POLL_INTERVAL_MS);
          }
        } else if (intervalId !== null) {
          window.clearInterval(intervalId);
          intervalId = null;
        }
      } catch (error) {
        if (!cancelled) {
          console.warn('Failed to refresh source index:', error);
        }
      }
    };

    void refresh();
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibility);
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [projectId, refreshSourceIndex]);

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
  }, [projectId, refreshSignedMediaUrls]);

  const importSources = useCallback(async (
    files: File[],
    insertionMode: 'append' | 'insert',
    insertAtTime?: number,
  ) => {
    const videoFiles = files.filter((file) => file.type.startsWith('video/'));
    if (videoFiles.length === 0) return;
    const targetProjectId = useEditorStore.getState().currentProjectId ?? projectId;
    if (!targetProjectId) return;
    const hadSources = useEditorStore.getState().sources.length > 0;
    const drafts: Array<{
      file: File;
      fileName: string;
      duration: number;
      runtime: {
        file: File;
        objectUrl: string;
        playerUrl: string;
        processingUrl: string;
      };
    }> = [];

    for (const file of videoFiles) {
      const objectUrl = URL.createObjectURL(file);
      const duration = await readVideoDuration(objectUrl);
      if (duration > 30 * 60) {
        URL.revokeObjectURL(objectUrl);
        setStorageNotice('Videos over 30 minutes are not supported yet. Please trim or split the video first.');
        continue;
      }
      drafts.push({
        file,
        fileName: file.name,
        duration,
        runtime: {
          file,
          objectUrl,
          playerUrl: objectUrl,
          processingUrl: objectUrl,
        },
      });
    }

    if (drafts.length === 0) return;

    const addedSources = importSourceDrafts(
      drafts.map((draft) => ({
        fileName: draft.fileName,
        duration: draft.duration,
        runtime: draft.runtime,
      })),
      {
        shouldAppendClips: true,
        insertAtTime: insertionMode === 'insert' ? insertAtTime : undefined,
      },
    );

    void queueProjectStateSync(targetProjectId);

    if (!user) return;

    await Promise.all(addedSources.map(async (source, index) => {
      const draft = drafts[index];
      const folder = !hadSources && index === 0 && source.isPrimary ? 'main' : 'sources';
      try {
        const uploaded = await uploadProjectMedia(draft.file, targetProjectId, folder);
        updateSource(source.id, {
          storagePath: uploaded.storagePath,
          assetId: uploaded.assetId,
          status: uploaded.assetId ? 'indexing' : 'pending',
        });
        void queueProjectStateSync(targetProjectId);
        handleStorageUploadSuccess();
      } catch (error) {
        console.warn('Background upload failed:', error);
        updateSource(source.id, { status: 'error' });
        void queueProjectStateSync(targetProjectId);
        handleStorageUploadError(error);
      }
    }));
    await queueProjectStateSync(targetProjectId);
  }, [handleStorageUploadError, handleStorageUploadSuccess, importSourceDrafts, projectId, queueProjectStateSync, readVideoDuration, updateSource, user]);

  const hasDraggedVideoFiles = useCallback((dataTransfer: DataTransfer) => (
    Array.from(dataTransfer.files).some((file) => file.type.startsWith('video/'))
  ), []);

  const handleRootDrop = useCallback((e: React.DragEvent) => {
    if (!hasDraggedVideoFiles(e.dataTransfer)) return;
    e.preventDefault();
    void importSources(Array.from(e.dataTransfer.files), 'append');
  }, [hasDraggedVideoFiles, importSources]);

  const handleRootDragOver = useCallback((e: React.DragEvent) => {
    if (!hasDraggedVideoFiles(e.dataTransfer)) return;
    e.preventDefault();
  }, [hasDraggedVideoFiles]);

  const isActiveProjectReady = currentProjectId === projectId;
  const shouldShowProjectLoading = Boolean(projectId) && (isProjectLoading || !isActiveProjectReady);

  return (
    <div
      style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-base)', overflow: 'hidden' }}
      onDrop={handleRootDrop}
      onDragOver={handleRootDragOver}
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
                onImportSources={(files) => importSources(files, 'append')}
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
                : hasSources
                  ? <VideoPlayer ref={playerRef} videoRef={videoRef} />
                  : <EmptyDropZone importSources={(files) => importSources(files, 'append')} />
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
                onImportSources={importSources}
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
  importSources,
}: {
  importSources: (files: File[]) => void | Promise<void>;
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
          void importSources(Array.from(e.dataTransfer.files));
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
            {isDragging ? 'Drop your videos' : 'Import videos'}
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
          multiple
          style={{ display: 'none' }}
          onChange={e => {
            void importSources(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
