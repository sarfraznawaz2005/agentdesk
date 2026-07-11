// Pack/unpack embeddings for the collection_notes.embedding BLOB column, plus brute-force cosine
// similarity search over notes in scope. Mirrors ReelForge's packVector/unpackVector convention
// (packages/uniqueness/src/vector.ts) so both apps share the same on-disk little-endian Float32
// vector format.
//
// Uses DataView rather than Buffer's writeFloatLE/readFloatLE (ReelForge's literal approach):
// bun:sqlite hands blob columns back as a plain Uint8Array, not a Node Buffer, so
// Buffer-only methods aren't available on a value read straight out of a real query — DataView
// works identically for both. Both functions still copy defensively (a fresh backing
// ArrayBuffer/Float32Array each time) so neither the stored bytes nor a returned Float32Array
// aliases the other's memory.

/** Serialize an embedding vector to a standalone little-endian Float32 Buffer. */
export function packVector(vec: Float32Array): Buffer {
	const buf = Buffer.allocUnsafe(vec.length * 4);
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	for (let i = 0; i < vec.length; i++) {
		view.setFloat32(i * 4, vec[i] ?? 0, true);
	}
	return buf;
}

/** Deserialize a little-endian Float32 buffer (Buffer or plain Uint8Array) back into a vector. */
export function unpackVector(buf: Uint8Array): Float32Array {
	if (buf.byteLength % 4 !== 0) {
		throw new Error(`unpackVector: buffer length ${buf.byteLength} is not a multiple of 4 bytes`);
	}
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const out = new Float32Array(buf.byteLength / 4);
	for (let i = 0; i < out.length; i++) {
		out[i] = view.getFloat32(i * 4, true);
	}
	return out;
}

/** Cosine similarity in [-1, 1]. Normalizes defensively, so it's correct even for non-unit inputs. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	if (a.length !== b.length) {
		throw new Error("cosineSimilarity: vectors must have equal length");
	}
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		dot += x * y;
		normA += x * x;
		normB += y * y;
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}

export interface VectorEntry {
	id: string;
	vector: Float32Array;
}

export interface RankedMatch {
	id: string;
	similarity: number;
}

// Brute-force cosine search — fine at Collections' note-count scale (docs/collections-plan.md §7).
// Entries with a mismatched dimension count are skipped rather than thrown on, since a future
// model change could leave stale-dimension embeddings in the corpus until re-indexed.
export function rankBySimilarity(
	query: Float32Array,
	corpus: readonly VectorEntry[],
	limit?: number,
): RankedMatch[] {
	const ranked: RankedMatch[] = [];
	for (const entry of corpus) {
		if (entry.vector.length !== query.length) continue;
		ranked.push({ id: entry.id, similarity: cosineSimilarity(query, entry.vector) });
	}
	ranked.sort((a, b) => b.similarity - a.similarity);
	return limit !== undefined ? ranked.slice(0, limit) : ranked;
}
