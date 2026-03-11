'use client';

import Link from 'next/link';
import { useEffect, useMemo } from 'react';
import styles from './LandingPage.module.css';
import AutocutMark from '@/components/branding/AutocutMark';
import { useAuth } from '@/components/auth/AuthProvider';

export default function LandingPage() {
  const { user } = useAuth();

  const accessHref = useMemo(() => (user ? '/projects' : '/auth/login'), [user]);

  useEffect(() => {
    const htmlOverflowY = document.documentElement.style.overflowY;
    const bodyOverflowY = document.body.style.overflowY;
    const bodyOverflowX = document.body.style.overflowX;

    document.documentElement.style.overflowY = 'auto';
    document.body.style.overflowY = 'auto';
    document.body.style.overflowX = 'hidden';

    return () => {
      document.documentElement.style.overflowY = htmlOverflowY;
      document.body.style.overflowY = bodyOverflowY;
      document.body.style.overflowX = bodyOverflowX;
    };
  }, []);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link href="/" className={styles.brand}>
            <AutocutMark size={28} />
            <div>
              <strong>Autocut</strong>
              <span>AI-native video editing</span>
            </div>
          </Link>

          <nav className={styles.nav}>
            <a href="#top">Home</a>
            <Link href={accessHref}>Try</Link>
          </nav>

          <div className={styles.headerActions}>
            {!user && (
              <Link href="/auth/login" className={styles.headerLink}>
                Sign in
              </Link>
            )}
            <Link href={accessHref} className={styles.headerButton}>
              Try now
            </Link>
          </div>
        </div>
      </header>

      <main className={styles.main}>
        <section id="top" className={`${styles.hero} ${styles.snapSection}`}>
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>For creators, not editors</p>
            <h1>Describe the edit. Autocut makes it.</h1>
            <p className={styles.heroDescription}>
              Most creators make the same edits every video. Autocut lets you say what should stay, what should go,
              and where the interesting part starts, then it handles the cuts, captions, and cleanup for you.
            </p>

            <div className={styles.heroActions}>
              <Link href={accessHref} className={styles.primaryButton}>
                Try now
              </Link>
              {!user && (
                <Link href="/auth/login" className={styles.secondaryButton}>
                  Sign in
                </Link>
              )}
            </div>

            <div className={styles.heroMeta}>
              <span>Plain-English edits</span>
              <span>Visual + audio indexing</span>
              <span>Timeline review</span>
            </div>
          </div>

          <aside className={styles.heroPanel}>
            <div className={styles.heroPanelIntro}>
              <p className={styles.panelLabel}>Autocut</p>
              <h2>Built for the creator who wants the result, not the software.</h2>
              <p className={styles.heroPanelText}>
                Instead of scrubbing through footage to find dead air, load screens, or the moment the demo actually
                starts, you just ask for the edit directly.
              </p>
            </div>

            <div className={styles.heroPanelFooter}>
              <div className={styles.fitCard}>
                <p className={styles.panelLabel}>Works well for</p>
                <div className={styles.fitList}>
                  <span>Gaming</span>
                  <span>Talking head</span>
                  <span>Product demos</span>
                  <span>Captions</span>
                  <span>Interviews</span>
                </div>
              </div>

              <div className={styles.fitCard}>
                <p className={styles.panelLabel}>Where this goes</p>
                <p className={styles.fitDescription}>
                  The long-term goal is simple: Autocut learns the patterns behind your videos and gets you closer to a
                  finished first pass without you touching a timeline.
                </p>
                <Link href={accessHref} className={styles.panelLink}>
                  Try now
                </Link>
              </div>
            </div>
          </aside>
        </section>

        <section id="launch" className={`${styles.finalCta} ${styles.snapSection}`}>
          <div className={styles.finalCtaCard}>
            <p className={styles.eyebrow}>Start editing faster</p>
            <h2>If you make the same three or four edits every upload, this is for you.</h2>
            <p className={styles.finalCtaText}>
              Try Autocut on real footage and see how quickly you can get to a usable cut.
            </p>
            <div className={styles.heroActions}>
              <Link href={accessHref} className={styles.primaryButton}>
                Try now
              </Link>
              {!user && (
                <Link href="/auth/login" className={styles.secondaryButton}>
                  Sign in
                </Link>
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
