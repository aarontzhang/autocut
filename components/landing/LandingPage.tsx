'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useMemo, useState } from 'react';
import DemoLightbox from './DemoLightbox';
import styles from './LandingPage.module.css';
import AutocutMark from '@/components/branding/AutocutMark';
import { useAuth } from '@/components/auth/AuthProvider';

const featureCards = [
  {
    eyebrow: 'Chat editing',
    title: 'Direct the cut in plain English.',
    description: 'Ask Autocut to trim filler, tighten phrasing, or rework pacing without hunting through a dense timeline.',
    image: '/landing/feature-chat.svg',
  },
  {
    eyebrow: 'Semantic search',
    title: 'Find moments by meaning, not timestamps.',
    description: 'Search for what was said or what happened on-screen, then jump straight to the right segment.',
    image: '/landing/feature-search.svg',
  },
  {
    eyebrow: 'Captions and export',
    title: 'Review the result and ship it fast.',
    description: 'Inspect captions, nudge clips on the timeline, and export polished cuts from the same workspace.',
    image: '/landing/feature-export.svg',
  },
];

const workflowSteps = [
  { title: 'Import', description: 'Drop in a recording, interview, demo, or long-form edit session.' },
  { title: 'Ask', description: 'Describe the edit you want instead of stacking tiny manual operations.' },
  { title: 'Review', description: 'See the cut, inspect the timeline, and refine with another prompt.' },
  { title: 'Export', description: 'Finalize captions, timing, and output without leaving the editor.' },
];

const placeholderScenarios = ['Placeholder: podcasts', 'Placeholder: tutorials', 'Placeholder: demos', 'Placeholder: interviews'];

function EditorPreview() {
  return (
    <div className={styles.previewShell}>
      <div className={styles.previewChrome}>
        <div className={styles.previewDots}>
          <span />
          <span />
          <span />
        </div>
        <div className={styles.previewTabs}>
          <span className={styles.previewTabActive}>Autocut Session</span>
          <span>Semantic Search</span>
          <span>Exports</span>
        </div>
      </div>

      <div className={styles.previewBody}>
        <div className={styles.previewWorkspace}>
          <aside className={styles.previewMediaRail}>
            <p className={styles.previewLabel}>Media</p>
            <div className={styles.previewMediaCard}>
              <span>main-interview.mp4</span>
              <small>08:36</small>
            </div>
            <div className={styles.previewMediaCard}>
              <span>b-roll-demo.mov</span>
              <small>01:42</small>
            </div>
            <div className={styles.previewMediaCard}>
              <span>music-bed.wav</span>
              <small>02:10</small>
            </div>
          </aside>

          <div className={styles.previewViewport}>
            <div className={styles.previewPlayerFrame}>
              <div className={styles.previewPlayerGradient} />
              <div className={styles.previewPlayerHud}>
                <span>Project walkthrough</span>
                <span>01:24 / 08:36</span>
              </div>
              <div className={styles.previewPlayerCaption}>“Cut to the section where the product demo starts.”</div>
            </div>

            <div className={styles.previewTimeline}>
              <div className={styles.previewTimelineHeader}>
                <span>Timeline</span>
                <span>3 tracks</span>
              </div>
              <div className={styles.previewTrack}>
                <div className={`${styles.previewClip} ${styles.previewClipBright}`} style={{ width: '28%' }} />
                <div className={styles.previewClip} style={{ width: '18%' }} />
                <div className={`${styles.previewClip} ${styles.previewClipMuted}`} style={{ width: '32%' }} />
              </div>
              <div className={styles.previewTrack}>
                <div className={`${styles.previewClip} ${styles.previewClipAudio}`} style={{ width: '22%' }} />
                <div className={`${styles.previewClip} ${styles.previewClipAudio}`} style={{ width: '41%' }} />
                <div className={`${styles.previewClip} ${styles.previewClipAudio}`} style={{ width: '14%' }} />
              </div>
              <div className={styles.previewTrack}>
                <div className={`${styles.previewClip} ${styles.previewClipCaption}`} style={{ width: '16%' }} />
                <div className={`${styles.previewClip} ${styles.previewClipCaption}`} style={{ width: '24%' }} />
                <div className={`${styles.previewClip} ${styles.previewClipCaption}`} style={{ width: '19%' }} />
              </div>
              <div className={styles.previewPlayhead} />
            </div>
          </div>

          <aside className={styles.previewSidebar}>
            <div className={styles.previewSidebarSection}>
              <p className={styles.previewLabel}>Chat</p>
              <div className={styles.commandChip}>“Trim pauses longer than 0.4s and add captions.”</div>
            </div>
            <div className={styles.previewSidebarSection}>
              <p className={styles.previewLabel}>Results</p>
              <div className={styles.previewResultCard}>
                <strong>Auto actions</strong>
                <span>12 cuts suggested</span>
              </div>
              <div className={styles.previewResultCard}>
                <strong>Caption pass</strong>
                <span>Ready for review</span>
              </div>
              <div className={styles.previewResultCard}>
                <strong>Visual search</strong>
                <span>3 matching scenes</span>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

export default function LandingPage() {
  const { user } = useAuth();
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const accessHref = useMemo(() => (user ? '/projects' : '/auth/login'), [user]);
  const accessLabel = user ? 'Open dashboard' : 'Start with Autocut';

  return (
    <>
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
              <a href="#features">Features</a>
              <a href="#workflow">Workflow</a>
              <a href="#launch">Launch</a>
            </nav>

            <div className={styles.headerActions}>
              {!user && (
                <Link href="/auth/login" className={styles.headerLink}>
                  Sign in
                </Link>
              )}
              <Link href={accessHref} className={styles.headerButton}>
                {user ? 'Dashboard' : 'Get access'}
              </Link>
            </div>
          </div>
        </header>

        <main className={styles.main}>
          <section id="top" className={`${styles.hero} ${styles.snapSection}`}>
            <div className={styles.heroCopy}>
              <p className={styles.eyebrow}>Cursor for video editing</p>
              <h1>Direct the edit. Review the timeline. Ship the cut.</h1>
              <p className={styles.heroDescription}>
                Autocut combines chat-driven editing, semantic video search, and a real timeline so you can move from raw footage to polished output faster.
              </p>

              <div className={styles.heroActions}>
                <button className={styles.primaryButton} onClick={() => setLightboxOpen(true)}>
                  Watch how it works
                </button>
                <Link href={accessHref} className={styles.secondaryButton}>
                  {accessLabel}
                </Link>
              </div>

              <div className={styles.heroMeta}>
                <span>Chat-first editing</span>
                <span>Semantic scene search</span>
                <span>Timeline and captions in one surface</span>
              </div>
            </div>

            <div className={styles.heroMedia}>
              <EditorPreview />
            </div>
          </section>

          <section className={styles.placeholderBand} aria-label="Placeholder scenarios">
            <p className={styles.placeholderLabel}>Placeholder positioning preview</p>
            <div className={styles.placeholderItems}>
              {placeholderScenarios.map(item => (
                <span key={item}>{item}</span>
              ))}
            </div>
          </section>

          <section id="features" className={`${styles.featureSection} ${styles.snapSection}`}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>Built for the actual editing loop</p>
              <h2>One product surface from prompt to final export.</h2>
              <p>
                The landing page follows Cursor’s section cadence, but the product story stays grounded in Autocut’s existing editor and AI-assisted video workflow.
              </p>
            </div>

            <div className={styles.featureGrid}>
              {featureCards.map((feature, index) => (
                <article
                  key={feature.title}
                  className={`${styles.featureCard} ${index % 2 === 1 ? styles.featureCardReverse : ''}`}
                >
                  <div className={styles.featureMedia}>
                    <Image src={feature.image} alt="" width={1200} height={780} unoptimized />
                  </div>
                  <div className={styles.featureCopy}>
                    <p className={styles.eyebrow}>{feature.eyebrow}</p>
                    <h3>{feature.title}</h3>
                    <p>{feature.description}</p>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section id="workflow" className={`${styles.workflowSection} ${styles.snapSection}`}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>Workflow</p>
              <h2>Import, ask, review, export.</h2>
              <p>A compact product story for users who want to understand the editing loop in seconds.</p>
            </div>

            <div className={styles.workflowGrid}>
              {workflowSteps.map((step, index) => (
                <div key={step.title} className={styles.workflowCard}>
                  <span className={styles.workflowIndex}>0{index + 1}</span>
                  <h3>{step.title}</h3>
                  <p>{step.description}</p>
                </div>
              ))}
            </div>
          </section>

          <section id="launch" className={`${styles.finalCta} ${styles.snapSection}`}>
            <div className={styles.finalCtaCard}>
              <p className={styles.eyebrow}>See the product flow</p>
              <h2>Watch the walkthrough, then step into the editor.</h2>
              <p>
                The demo slot is wired for a real product video later. For now, the page ships with local placeholder media that can be swapped without changing code.
              </p>
              <div className={styles.heroActions}>
                <button className={styles.primaryButton} onClick={() => setLightboxOpen(true)}>
                  Play walkthrough
                </button>
                <Link href={accessHref} className={styles.secondaryButton}>
                  {accessLabel}
                </Link>
              </div>
            </div>
          </section>
        </main>
      </div>

      <DemoLightbox
        open={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
        posterSrc="/landing/demo-poster.svg"
        videoSrc="/landing/demo-loop.mp4"
        title="How Autocut works"
        description="This placeholder lightbox is ready for the real walkthrough recording. Until then, it uses local placeholder media so the interaction is already implemented."
      />
    </>
  );
}
