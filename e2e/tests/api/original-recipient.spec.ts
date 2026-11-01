import { test, expect, type APIRequestContext } from '@playwright/test';
import { WORKER_URL } from '../../fixtures/test-helpers';

const LEGACY_ADDRESS = 'duck3@email.example.com';

async function clearMails(ctx: APIRequestContext, address: string) {
  const res = await ctx.delete(`${WORKER_URL}/admin/mails?address=${encodeURIComponent(address)}`);
  expect(res.ok()).toBe(true);
}

async function seedRawMail(
  ctx: APIRequestContext,
  opts: {
    address?: string;
    source?: string;
    headers?: string[];
    subject?: string;
    body?: string;
  }
) {
  const address = opts.address || LEGACY_ADDRESS;
  const source = opts.source || 'sender@test.example.com';
  const messageId = `<orig-recipient-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@test>`;
  const raw = [
    ...(opts.headers || []),
    `From: ${source}`,
    `To: ${address}`,
    `Subject: ${opts.subject || 'Original Recipient Test'}`,
    `Message-ID: ${messageId}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    opts.body || 'Hello from original recipient E2E',
  ].join('\r\n');

  const res = await ctx.post(`${WORKER_URL}/admin/test/seed_mail`, {
    data: { address, source, raw, message_id: messageId },
  });
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body.success).toBe(true);
  return { address, messageId };
}

async function getSeededAdminMail(ctx: APIRequestContext, address: string, messageId: string) {
  const res = await ctx.get(
    `${WORKER_URL}/admin/mails?limit=10&offset=0&address=${encodeURIComponent(address)}`,
  );
  expect(res.ok()).toBe(true);
  const body = await res.json();
  const mail = body.results.find((item: any) => item.message_id === messageId);
  expect(mail).toBeDefined();
  return mail;
}

test.describe('Original recipient field', () => {
  test.beforeEach(async ({ request }) => {
    await clearMails(request, LEGACY_ADDRESS);
  });

  test.afterEach(async ({ request }) => {
    await clearMails(request, LEGACY_ADDRESS);
  });

  test('keeps /admin/mails address filtering compatible', async ({ request }) => {
    const { address, messageId } = await seedRawMail(request, {
      subject: 'Legacy Address Filter',
    });

    const mail = await getSeededAdminMail(request, address, messageId);
    expect(mail.address).toBe(LEGACY_ADDRESS);
  });

  test('extracts X-Original-To from raw headers', async ({ request }) => {
    const { address, messageId } = await seedRawMail(request, {
      headers: ['X-Original-To: fester-flaky-bats@duck.com'],
      subject: 'X Original To',
    });

    const mail = await getSeededAdminMail(request, address, messageId);
    expect(mail.original_recipient).toBe('fester-flaky-bats@duck.com');
  });

  test('extracts Delivered-To when it differs from address', async ({ request }) => {
    const { address, messageId } = await seedRawMail(request, {
      headers: ['Delivered-To: tmpfd9a05d90768@email.qlhazycoder.top'],
      subject: 'Delivered To',
    });

    const mail = await getSeededAdminMail(request, address, messageId);
    expect(mail.original_recipient).toBe('tmpfd9a05d90768@email.qlhazycoder.top');
  });

  test('extracts Duck source rewrite from source', async ({ request }) => {
    const { address, messageId } = await seedRawMail(request, {
      source: 'ChatGPT <noreply_at_tm.openai.com_fester-flaky-bats@duck.com>',
      subject: 'Duck Source Rewrite',
    });

    const mail = await getSeededAdminMail(request, address, messageId);
    expect(mail.original_recipient).toBe('fester-flaky-bats@duck.com');
  });

  test('prefers bounced local=domain recipient segment', async ({ request }) => {
    const { address, messageId } = await seedRawMail(request, {
      headers: ['X-Original-To: bounce+id-fester-flaky-bats=duck.com@forwarder.example.com'],
      subject: 'Bounce Local Equals Domain',
    });

    const mail = await getSeededAdminMail(request, address, messageId);
    expect(mail.original_recipient).toBe('fester-flaky-bats@duck.com');
  });

  test('falls back to delivered address when no forwarded recipient is inferred', async ({ request }) => {
    const { address, messageId } = await seedRawMail(request, {
      subject: 'Delivered Address Fallback',
    });

    const mail = await getSeededAdminMail(request, address, messageId);
    expect(mail.original_recipient).toBe(address);
  });

  test('filters /admin/mails by original_recipient', async ({ request }) => {
    const target = await seedRawMail(request, {
      headers: ['X-Original-To: filter-target@duck.com'],
      subject: 'Original Recipient Filter Target',
    });
    const other = await seedRawMail(request, {
      headers: ['X-Original-To: filter-other@duck.com'],
      subject: 'Original Recipient Filter Other',
    });

    const res = await request.get(
      `${WORKER_URL}/admin/mails?limit=10&offset=0&original_recipient=${encodeURIComponent(' Filter-Target@Duck.com ')}`,
    );
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const ids = body.results.map((item: any) => item.message_id);
    expect(ids).toContain(target.messageId);
    expect(ids).not.toContain(other.messageId);
    for (const item of body.results) {
      expect(item.original_recipient).toBe('filter-target@duck.com');
    }

    const combined = await request.get(
      `${WORKER_URL}/admin/mails?limit=10&offset=0&address=${encodeURIComponent('nobody@email.example.com')}&original_recipient=filter-target@duck.com`,
    );
    expect(combined.ok()).toBe(true);
    const combinedBody = await combined.json();
    expect(combinedBody.results.map((item: any) => item.message_id)).not.toContain(target.messageId);
  });
});
