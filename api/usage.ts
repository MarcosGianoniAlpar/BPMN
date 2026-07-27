import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendUsage } from '../dist/httpHandlers.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.writeHead(405).end('Method not allowed');
    return;
  }
  await sendUsage(res);
}
