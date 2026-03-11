'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import styles from './LandingPage.module.css';
import AutocutMark from '@/components/branding/AutocutMark';
import { useAuth } from '@/components/auth/AuthProvider';

export default function LandingPage() {
  const { user } = useAuth();
  const accessHref = user ? '/projects' : '/auth/login';
  const ctaLabel = user ? 'Open projects' : 'Sign in to try Autocut';

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
            <a href="#how-it-works">How it works</a>
            <a href="#login">Login</a>
          </nav>

          <div className={styles.headerActions}>
            {!user && (
              <Link href="/auth/login" className={styles.headerLink}>
                Sign in
              </Link>
            )}
            <Link href={accessHref} className={styles.headerButton}>
              {user ? 'Projects' : 'Try Autocut'}
            </Link>
          </div>
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>Simple video editing</p>
            <h1>Edit video by describing what you want.</h1>
            <p className={styles.heroDescription}>
              Autocut helps you turn raw footage into a first pass. Upload a video, explain what to cut or keep, and
              review the result in the timeline.
            </p>

            <div className={styles.heroActions}>
              <Link href={accessHref} className={styles.primaryButton}>
                {ctaLabel}
              </Link>
              {!user && (
                <a href="#how-it-works" className={styles.secondaryButton}>
                  See how it works
                </a>
              )}
            </div>

            <div className={styles.heroMeta}>
              <span>Upload footage</span>
              <span>Describe the edit</span>
              <span>Review cuts and captions</span>
            </div>
          </div>

          <aside className={styles.heroPanel}>
            <p className={styles.panelLabel}>What Autocut does</p>
            <ul className={styles.summaryList}>
              <li>Turns plain-English instructions into a rough cut</li>
              <li>Finds the useful parts of your footage faster</li>
              <li>Adds captions so you can review a usable draft</li>
            </ul>
          </aside>
        </section>

        <section id="how-it-works" className={styles.stepsSection}>
          <div className={styles.sectionHeading}>
            <p className={styles.eyebrow}>How it works</p>
            <h2>Three steps from raw footage to first draft.</h2>
          </div>

          <div className={styles.stepsGrid}>
            <article className={styles.stepCard}>
              <span className={styles.stepNumber}>01</span>
              <h3>Upload your video</h3>
              <p>Start with a recording, demo, interview, or talking-head clip.</p>
            </article>

            <article className={styles.stepCard}>
              <span className={styles.stepNumber}>02</span>
              <h3>Describe the edit</h3>
              <p>Tell Autocut what to remove, where to start, and whether you want captions.</p>
            </article>

            <article className={styles.stepCard}>
              <span className={styles.stepNumber}>03</span>
              <h3>Review the result</h3>
              <p>Check the first pass in the timeline, then keep refining from there.</p>
            </article>
          </div>
        </section>

        <section id="login" className={styles.ctaSection}>
          <div className={styles.ctaCard}>
            <p className={styles.eyebrow}>Try it</p>
            <h2>Sign in to start your first edit.</h2>
            <p className={styles.ctaText}>Use Autocut on your own footage and go straight to the editor.</p>

            <div className={styles.heroActions}>
              <Link href={accessHref} className={styles.primaryButton}>
                {ctaLabel}
              </Link>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
