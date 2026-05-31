import { db } from "../db";
import { prompts } from "../db/schema";
import { eq } from "drizzle-orm";

export async function getPrompts() {
	return db.select().from(prompts).orderBy(prompts.name);
}

export async function getPrompt(id: string) {
	const rows = await db.select().from(prompts).where(eq(prompts.id, id));
	return rows[0] ?? null;
}

export async function savePrompt(params: {
	id?: string;
	name: string;
	description: string;
	content: string;
	category?: string;
}) {
	if (params.id) {
		await db
			.update(prompts)
			.set({
				name: params.name,
				description: params.description,
				content: params.content,
				category: params.category ?? "custom",
				updatedAt: new Date().toISOString(),
			})
			.where(eq(prompts.id, params.id));
		return { success: true, id: params.id };
	}
	const id = crypto.randomUUID();
	await db.insert(prompts).values({
		id,
		name: params.name,
		description: params.description,
		content: params.content,
		category: params.category ?? "custom",
	});
	return { success: true, id };
}

export async function deletePrompt(id: string) {
	await db.delete(prompts).where(eq(prompts.id, id));
	return { success: true };
}

export async function searchPrompts(query: string) {
	const all = await db.select().from(prompts).orderBy(prompts.name);
	if (!query.trim()) return all;
	const q = query.toLowerCase();
	return all.filter(
		(p) =>
			p.name.toLowerCase().includes(q) ||
			p.description.toLowerCase().includes(q),
	);
}
