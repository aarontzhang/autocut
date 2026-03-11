'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import styles from './LandingPage.module.css';

interface DemoLightboxProps {
  open: boolean;
  onClose: () => void;
  posterSrc: string;
  videoSrc?: string;
  title: string;
  description: string;
}

export default function DemoLightbox({
  open,
  onClose,
  posterSrc,
  videoSrc,
  title,
  description,
}: DemoLightboxProps) {
  const [videoAvailable, setVideoAvailable] = useState(Boolean(videoSrc));

  useEffect(() => {
    setVideoAvailable(Boolean(videoSrc));
  }, [videoSrc]);

  useEffect(() => {
    if (!open) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className={styles.lightboxOverlay} onClick={onClose} role="presentation">
      <div
        className={styles.lightboxCard}
        onClick={event => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="demo-lightbox-title"
      >
        <button className={styles.lightboxClose} onClick={onClose} aria-label="Close demo">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>

        <div className={styles.lightboxMedia}>
          <Image
            src={posterSrc}
            alt=""
            fill
            unoptimized
            sizes="(max-width: 980px) 100vw, 980px"
            className={styles.lightboxPoster}
          />
          {videoAvailable && videoSrc ? (
            <video
              className={styles.lightboxVideo}
              src={videoSrc}
              poster={posterSrc}
              controls
              autoPlay
              muted
              loop
              playsInline
              onError={() => setVideoAvailable(false)}
            />
          ) : (
            <div className={styles.lightboxFallback}>
              <div className={styles.lightboxFallbackIcon}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
              <span>Walkthrough video placeholder</span>
            </div>
          )}
        </div>

        <div className={styles.lightboxCopy}>
          <p className={styles.eyebrow}>Product demo</p>
          <h2 id="demo-lightbox-title">{title}</h2>
          <p>{description}</p>
        </div>
      </div>
    </div>
  );
}
