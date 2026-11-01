import { expect, test, type APIRequestContext } from '@playwright/test';

import {
  TEST_DOMAIN,
  WORKER_URL,
  createTestAddress,
  deleteAddress,
} from '../../fixtures/test-helpers';

/**
 * original_recipient is inferred by the real email() handler, so these tests go
 * through /__test/receive_mail rather than seeding rows directly.
 */
async function receiveMail(
  ctx: APIRequestContext,
  address: string,
  opts: { headers?: string[]; subject?: string; from?: string } = {}
): Promise<string> {
  const from = opts.from || `sender@${TEST_DOMAIN}`;
  const messageId = `<orig-recipient-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@test>`;
  const raw = [
    ...(opts.headers || []),
    `From: ${from}`,
    `To: ${address}`,
    `Subject: ${opts.subject || 'Original Recipient Test'}`,
    `Message-ID: ${messageId}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Hello from original recipient E2E',
  ].join('\r\n');

  const res = await ctx.post(`${WORKER_URL}/__test/receive_mail`, {
    data: { from, to: address, raw },
  });
  expect(res.ok()).toBe(true);
  expect((await res.json()).success).toBe(true);
  return messageId;
}

async function getMailByMessageId(
  ctx: APIRequestContext,
  address: string,
  messageId: string
) {
  const res = await ctx.get(
    `${WORKER_URL}/admin/mails?limit=10&offset=0&address=${encodeURIComponent(address)}`
  );
  expect(res.ok()).toBe(true);
  const mail = (await res.json()).results.find((item: any) => item.message_id === messageId);
  expect(mail).toBeDefined();
  return mail;
}

test.describe('Original recipient field', () => {
  test('keeps /admin/mails address filtering compatible', async ({ request }) => {
    const mailbox = await createTestAddress(request, 'orig-legacy');
    try {
      const messageId = await receiveMail(request, mailbox.address, {
        subject: 'Legacy Address Filter',
      });
      const mail = await getMailByMessageId(request, mailbox.address, messageId);
      expect(mail.address).toBe(mailbox.address);
    } finally {
      await deleteAddress(request, mailbox.jwt);
    }
  });

  test('extracts X-Original-To from raw headers', async ({ request }) => {
    const mailbox = await createTestAddress(request, 'orig-xto');
    try {
      const messageId = await receiveMail(request, mailbox.address, {
        headers: ['X-Original-To: fester-flaky-bats@duck.com'],
        subject: 'X Original To',
      });
      const mail = await getMailByMessageId(request, mailbox.address, messageId);
      expect(mail.original_recipient).toBe('fester-flaky-bats@duck.com');
    } finally {
      await deleteAddress(request, mailbox.jwt);
    }
  });

  test('extracts Delivered-To when it differs from address', async ({ request }) => {
    const mailbox = await createTestAddress(request, 'orig-delivered');
    try {
      const messageId = await receiveMail(request, mailbox.address, {
        headers: ['Delivered-To: tmpfd9a05d90768@email.qlhazycoder.top'],
        subject: 'Delivered To',
      });
      const mail = await getMailByMessageId(request, mailbox.address, messageId);
      expect(mail.original_recipient).toBe('tmpfd9a05d90768@email.qlhazycoder.top');
    } finally {
      await deleteAddress(request, mailbox.jwt);
    }
  });

  test('extracts Duck source rewrite from source', async ({ request }) => {
    const mailbox = await createTestAddress(request, 'orig-duck');
    try {
      const messageId = await receiveMail(request, mailbox.address, {
        from: 'noreply_at_tm.openai.com_fester-flaky-bats@duck.com',
        subject: 'Duck Source Rewrite',
      });
      const mail = await getMailByMessageId(request, mailbox.address, messageId);
      expect(mail.original_recipient).toBe('fester-flaky-bats@duck.com');
    } finally {
      await deleteAddress(request, mailbox.jwt);
    }
  });

  test('prefers bounced local=domain recipient segment', async ({ request }) => {
    const mailbox = await createTestAddress(request, 'orig-bounce');
    try {
      const messageId = await receiveMail(request, mailbox.address, {
        headers: ['X-Original-To: bounce+id-fester-flaky-bats=duck.com@forwarder.example.com'],
        subject: 'Bounce Local Equals Domain',
      });
      const mail = await getMailByMessageId(request, mailbox.address, messageId);
      expect(mail.original_recipient).toBe('fester-flaky-bats@duck.com');
    } finally {
      await deleteAddress(request, mailbox.jwt);
    }
  });

  test('falls back to delivered address when no forwarded recipient is inferred', async ({ request }) => {
    const mailbox = await createTestAddress(request, 'orig-fallback');
    try {
      const messageId = await receiveMail(request, mailbox.address, {
        subject: 'Delivered Address Fallback',
      });
      const mail = await getMailByMessageId(request, mailbox.address, messageId);
      expect(mail.original_recipient).toBe(mailbox.address);
    } finally {
      await deleteAddress(request, mailbox.jwt);
    }
  });

  test('filters /admin/mails by original_recipient', async ({ request }) => {
    const mailbox = await createTestAddress(request, 'orig-filter');
    try {
      const targetId = await receiveMail(request, mailbox.address, {
        headers: ['X-Original-To: filter-target@duck.com'],
        subject: 'Original Recipient Filter Target',
      });
      const otherId = await receiveMail(request, mailbox.address, {
        headers: ['X-Original-To: filter-other@duck.com'],
        subject: 'Original Recipient Filter Other',
      });

      // Query value is trimmed and lowercased server-side.
      const res = await request.get(
        `${WORKER_URL}/admin/mails?limit=10&offset=0`
        + `&original_recipient=${encodeURIComponent(' Filter-Target@Duck.com ')}`
      );
      expect(res.ok()).toBe(true);
      const ids = (await res.json()).results.map((item: any) => item.message_id);
      expect(ids).toContain(targetId);
      expect(ids).not.toContain(otherId);

      // address and original_recipient combine with AND.
      const combined = await request.get(
        `${WORKER_URL}/admin/mails?limit=10&offset=0`
        + `&address=${encodeURIComponent('nobody@' + TEST_DOMAIN)}`
        + `&original_recipient=filter-target@duck.com`
      );
      expect(combined.ok()).toBe(true);
      const combinedIds = (await combined.json()).results.map((item: any) => item.message_id);
      expect(combinedIds).not.toContain(targetId);
    } finally {
      await deleteAddress(request, mailbox.jwt);
    }
  });
});