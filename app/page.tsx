'use client';

import { Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import EditorLayout from '@/components/editor/EditorLayout';

function HomeContent() {
  const searchParams = useSearchParams();
  const projectId = searchParams.get('project');
  const router = useRouter();

  useEffect(() => {
    if (!projectId) router.replace('/projects');
  }, [projectId, router]);

  if (!projectId) return null;
  return <EditorLayout projectId={projectId} />;
}

export default function Home() {
  return (
    <Suspense>
      <HomeContent />
    </Suspense>
  );
}
