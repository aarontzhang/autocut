'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import ProjectDashboard from '@/components/projects/ProjectDashboard';
import { getSupabaseBrowser } from '@/lib/supabase/client';

export interface Project {
  id: string;
  name: string;
  video_filename: string | null;
  video_size: number | null;
  video_path: string | null;
  thumbnailUrl: string | null;
  created_at: string;
  updated_at: string;
}

function UserMenu({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleSignOut = async () => {
    await getSupabaseBrowser().auth.signOut();
    router.push('/auth/login');
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        title={email}
        style={{
          width: 30, height: 30, borderRadius: '50%',
          background: 'var(--accent)', border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, fontWeight: 600, color: '#fff',
        }}
      >
        {email[0]?.toUpperCase() ?? '?'}
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 38, right: 0, zIndex: 100,
          background: 'var(--bg-panel)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          minWidth: 200,
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          overflow: 'hidden',
        }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
            <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {email}
            </p>
          </div>
          <button
            onClick={handleSignOut}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              width: '100%', padding: '9px 14px',
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 12, color: 'var(--fg-secondary)', textAlign: 'left',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; e.currentTarget.style.color = '#f87171'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--fg-secondary)'; }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [userEmail, setUserEmail] = useState('');
  const router = useRouter();

  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.json())
      .then(data => { setProjects(Array.isArray(data) ? data : []); setLoading(false); })
      .catch(() => setLoading(false));

    getSupabaseBrowser().auth.getUser().then(({ data }) => {
      setUserEmail(data.user?.email ?? '');
    });
  }, []);

  const handleNew = async () => {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Untitled Project' }),
    });
    if (!res.ok) return;
    const { id } = await res.json();
    router.push(`/?project=${id}`);
  };

  const handleOpen = (id: string) => router.push(`/?project=${id}`);

  const handleDelete = async (id: string) => {
    await fetch(`/api/projects/${id}`, { method: 'DELETE' });
    setProjects(prev => prev.filter(p => p.id !== id));
  };

  const handleRename = async (id: string, name: string) => {
    await fetch(`/api/projects/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    setProjects(prev => prev.map(p => p.id === id ? { ...p, name } : p));
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)', padding: '0 0 40px' }}>
      {/* Header */}
      <div style={{
        height: 52, background: 'var(--bg-panel)', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', padding: '0 24px', gap: 12,
      }}>
        <img src="/logo.png" width={20} height={20} style={{ display: 'block', flexShrink: 0 }} alt="Claude Cut" />
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg-primary)', letterSpacing: '-0.02em' }}>Claude Cut</span>
        <div style={{ flex: 1 }} />
        {userEmail && <UserMenu email={userEmail} />}
      </div>

      <ProjectDashboard
        projects={projects}
        loading={loading}
        onNew={handleNew}
        onOpen={handleOpen}
        onDelete={handleDelete}
        onRename={handleRename}
      />
    </div>
  );
}
