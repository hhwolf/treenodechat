import { timingSafeEqual } from 'node:crypto';

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authorizeRequest(request, expectedToken = process.env.THREADLINE_ACCESS_TOKEN) {
  if (!expectedToken) return { ok: false, status: 503, error: 'THREADLINE_ACCESS_TOKEN is not configured' };
  const header = String(request.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!secureEqual(token, expectedToken)) return { ok: false, status: 401, error: 'Enter the Threadline access code to continue' };
  return { ok: true };
}

