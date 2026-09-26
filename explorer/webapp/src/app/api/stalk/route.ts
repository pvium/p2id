import { stalkRequestSchema } from '@/lib/stalk';

/**
 * Sign up to be notified when a handle's P2ID gets paid. Validates the request and hands it to
 * the explorer API, which decides eligibility (stalking can require holding tokens) and sends
 * the notifications.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Send JSON' }, { status: 400 });
  }
  const parsed = stalkRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
  }

  const api = process.env.P2ID_API_URL;
  if (!api) {
    return Response.json({ error: 'Stalking opens at launch. Come back soon 👀' }, { status: 503 });
  }
  try {
    const res = await fetch(new URL('/stalks', api), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed.data),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (!res.ok) return Response.json({ error: data.error ?? 'Could not start stalking' }, { status: res.status });
    return Response.json({ message: data.message ?? `Stalking @${parsed.data.handle}. We'll ping you when they get paid.` });
  } catch {
    return Response.json({ error: 'The explorer is unreachable right now. Try again in a bit.' }, { status: 502 });
  }
}
