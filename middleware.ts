import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

const PROTECTED_PAGES = ['/projects', '/editor', '/new'];
const PROTECTED_API_PREFIXES = [
  '/api/projects',
  '/api/uploads',
  '/api/transcribe',
  '/api/chat',
  '/api/storage',
  '/api/assets',
  '/api/frame-descriptions',
  '/api/visual-search',
  '/api/visual-verify',
  '/api/extract-audio',
];

function isProtectedPage(pathname: string) {
  return PROTECTED_PAGES.some(p => pathname === p || pathname.startsWith(p + '/'));
}

function isProtectedApi(pathname: string) {
  return PROTECTED_API_PREFIXES.some(p => pathname === p || pathname.startsWith(p + '/'));
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Skip static assets, Next.js internals, and public paths
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/ffmpeg') ||
    pathname.startsWith('/ingest') ||
    pathname.includes('.')
  ) {
    return NextResponse.next();
  }

  // Only gate protected pages and APIs
  if (!isProtectedPage(pathname) && !isProtectedApi(pathname)) {
    return NextResponse.next();
  }

  // Create Supabase server client for proxy
  let response = NextResponse.next({ request: { headers: req.headers } });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return req.cookies.getAll(); },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => {
            req.cookies.set(name, value);
          });
          response = NextResponse.next({ request: req });
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();

  // Not logged in
  if (!user) {
    if (isProtectedApi(pathname)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const loginUrl = new URL('/auth/login', req.url);
    loginUrl.searchParams.set('redirect', pathname + req.nextUrl.search);
    return NextResponse.redirect(loginUrl);
  }

  // Subscription gating — redirect to /subscribe if no active subscription
  if (isProtectedPage(pathname)) {
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('status')
      .eq('user_id', user.id)
      .in('status', ['active', 'trialing'])
      .limit(1)
      .maybeSingle();

    if (!sub) {
      return NextResponse.redirect(new URL('/subscribe', req.url));
    }
  }

  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.svg|favicon\\.ico|ffmpeg/).*)',
  ],
};
