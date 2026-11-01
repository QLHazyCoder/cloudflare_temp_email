import { Context } from "hono";
import { handleMailListQuery } from "../common";

export default {
    getMails: async (c: Context<HonoCustomType>) => {
        const { address, original_recipient, limit, offset } = c.req.query();
        // original_recipient is stored trimmed and lowercased, so normalize the
        // query the same way. Filtering in SQL means only matching rows are
        // decompressed, instead of every row of an unfiltered page.
        const originalRecipient = (original_recipient || "").trim().toLowerCase();
        const filters: string[] = [];
        const filterParams: string[] = [];
        if (address) {
            filters.push("address = ?");
            filterParams.push(address);
        }
        if (originalRecipient) {
            filters.push("original_recipient = ?");
            filterParams.push(originalRecipient);
        }
        const finalQuery = filters.length > 0 ? `where ${filters.join(" and ")}` : "";
        return await handleMailListQuery(c,
            `SELECT * FROM raw_mails ${finalQuery}`,
            `SELECT count(*) as count FROM raw_mails ${finalQuery}`,
            filterParams, limit, offset
        );
    },
    getUnknowMails: async (c: Context<HonoCustomType>) => {
        const { limit, offset } = c.req.query();
        return await handleMailListQuery(c,
            `SELECT * FROM raw_mails where address NOT IN (select name from address) `,
            `SELECT count(*) as count FROM raw_mails`
            + ` where address NOT IN (select name from address) `,
            [], limit, offset
        );
    },
    deleteMail: async (c: Context<HonoCustomType>) => {
        const { id } = c.req.param();
        const { success } = await c.env.DB.prepare(
            `DELETE FROM raw_mails WHERE id = ? `
        ).bind(id).run();
        return c.json({
            success: success
        })
    },
    clearMails: async (c: Context<HonoCustomType>) => {
        const { address } = c.req.query();
        const statement = address
            ? c.env.DB.prepare(`DELETE FROM raw_mails WHERE address = ?`).bind(address)
            : c.env.DB.prepare(`DELETE FROM raw_mails`);
        const result = await statement.run();
        return c.json({
            success: result.success,
            changes: result.meta?.changes ?? 0
        })
    }
}
