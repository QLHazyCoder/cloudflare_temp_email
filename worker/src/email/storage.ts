import { Context } from "hono";
import { createMimeMessage } from "mimetext";

import { compressText } from "../gzip";
import { getBooleanValue } from "../utils";
import { getStoredOriginalRecipient } from "./original_recipient";

let rawMailTableColumns: Set<string> | undefined;

const getRawMailTableColumns = async (
    env: Bindings, requiredColumns: string[]
): Promise<Set<string>> => {
    const cachedColumns = rawMailTableColumns;
    if (cachedColumns && requiredColumns.every(column => cachedColumns.has(column))) {
        return cachedColumns;
    }
    const tableInfo = await env.DB.prepare(`PRAGMA table_info(raw_mails)`).all<{ name: string }>();
    const columns = new Set(tableInfo.results.map(column => column.name));
    if (requiredColumns.every(column => columns.has(column))) {
        rawMailTableColumns = columns;
    }
    return columns;
}

export const storeRawMail = async (
    env: Bindings,
    source: string,
    address: string,
    messageId: string | null,
    raw: string,
    originalRecipient?: string | null,
): Promise<D1Result> => {
    const gzipEnabled = getBooleanValue(env.ENABLE_MAIL_GZIP);
    const readStatusEnabled = getBooleanValue(env.ENABLE_MAIL_READ_STATUS);
    const requiredColumns: string[] = ['original_recipient'];
    if (gzipEnabled) requiredColumns.push('raw_blob');
    if (readStatusEnabled) requiredColumns.push('is_unread');

    const tableColumns = await getRawMailTableColumns(env, requiredColumns);

    let rawBlob: ArrayBuffer | undefined;
    if (gzipEnabled && tableColumns.has('raw_blob')) {
        try {
            rawBlob = await compressText(raw);
        } catch (error) {
            console.error("gzip compression failed, falling back to plaintext", error);
        }
    }

    const storeUnreadStatus = readStatusEnabled && tableColumns.has('is_unread');
    // original_recipient only exists after the 2026-05-16 migration; skip the
    // column on older databases so inserts keep working instead of failing.
    const storeOriginalRecipient = tableColumns.has('original_recipient');

    const columns = ['source', 'address', rawBlob ? 'raw_blob' : 'raw', 'message_id'];
    const placeholders = ['?', '?', '?', '?'];
    const values: unknown[] = [source, address, rawBlob ?? raw, messageId];
    if (storeOriginalRecipient) {
        columns.push('original_recipient');
        placeholders.push('?');
        values.push(originalRecipient || null);
    }
    if (storeUnreadStatus) {
        columns.push('is_unread');
        placeholders.push('1');
    }
    return env.DB.prepare(
        `INSERT INTO raw_mails (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`
    ).bind(...values).run();
}

export const sendAdminInternalMail = async (
    c: Context<HonoCustomType>, toMail: string, subject: string, text: string
): Promise<boolean> => {
    try {
        const msg = createMimeMessage();
        msg.setSender({
            name: "Admin",
            addr: "admin@internal"
        });
        msg.setRecipient(toMail);
        msg.setSubject(subject);
        msg.addMessage({
            contentType: 'text/plain',
            data: text
        });
        const messageId = Math.random().toString(36).substring(2, 15);
        const rawText = msg.asRaw();
        const { success } = await storeRawMail(
            c.env, "admin@internal", toMail, messageId, rawText,
            getStoredOriginalRecipient({
                address: toMail,
                source: "admin@internal",
                rawEmail: rawText,
            }) || null
        );
        if (!success) {
            console.log(`Failed save message from admin@internal to ${toMail}`);
        }
        return success;
    } catch (error) {
        console.log("sendAdminInternalMail error", error);
        return false;
    }
};
