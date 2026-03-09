'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import ProjectDashboard from '@/components/projects/ProjectDashboard';
import { useAuth } from '@/components/auth/AuthProvider';
import UserProfileMenu from '@/components/auth/UserProfileMenu';
import AutocutMark from '@/components/branding/AutocutMark';

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

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const { user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.json())
      .then(data => { setProjects(Array.isArray(data) ? data : []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const handleNew = async () => {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Untitled Project', edit_state: {} }),
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
        <AutocutMark size={22} />
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg-primary)', letterSpacing: '-0.02em' }}>Autocut</span>
        <div style={{ flex: 1 }} />
        {user && <UserProfileMenu user={user} dashboardLabel="Go to Dashboard" />}
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
