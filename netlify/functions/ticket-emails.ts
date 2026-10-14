import type { Handler } from '@netlify/functions';
import { drainTicketEmails } from './send-email';

export const handler: Handler = async () => {
  try {
    return { statusCode: 200, body: JSON.stringify(await drainTicketEmails()) };
  } catch (error) {
    console.error('[ticket-emails]', error instanceof Error ? error.message : 'Worker failed');
    return { statusCode: 500, body: 'Email worker failed' };
  }
};