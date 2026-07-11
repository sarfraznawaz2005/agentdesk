// Generates embeddings for Collections notes/search/chat using the model downloaded by
// model-manager.ts. This module never fetches over the network — it only reads what's already
// on disk, so callers must check isEmbeddingModelDownloaded() (or handle the thrown error) first.
//
// @huggingface/transformers is imported dynamically inside getExtractor(), not at module top
// level — see model-manager.ts's top-of-file comment for why (this module is statically imported
// by chat.ts/indexer.ts, which are in turn reachable from app startup).

import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import { EMBEDDING_MODEL_ID, EMBEDDING_MODEL_DIMS, configureEmbeddingModelEnv, isEmbeddingModelDownloaded } from "./model-manager";

let cachedExtractor: FeatureExtractionPipeline | null = null;
let loadingPromise: Promise<FeatureExtractionPipeline> | null = null;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
	if (cachedExtractor) return cachedExtractor;
	if (!loadingPromise) {
		loadingPromise = (async () => {
			const { pipeline, env } = await import("@huggingface/transformers");
			await configureEmbeddingModelEnv();
			env.allowRemoteModels = false; // local-only — downloading is model-manager.ts's job, not ours
			const extractor = await pipeline("feature-extraction", EMBEDDING_MODEL_ID);
			cachedExtractor = extractor;
			return extractor;
		})().finally(() => {
			loadingPromise = null;
		});
	}
	return loadingPromise;
}

// Generates a 384-dim, L2-normalized embedding for a single string. Throws if the model hasn't
// been downloaded yet — callers should gate on isEmbeddingModelDownloaded() (or the Settings tab's
// "Ready" status) before calling this in a user-facing flow.
export async function embedText(text: string): Promise<Float32Array> {
	if (!isEmbeddingModelDownloaded()) {
		throw new Error("Embedding model is not downloaded yet — download it from Collections Settings first.");
	}
	const extractor = await getExtractor();
	const output = await extractor(text, { pooling: "mean", normalize: true });
	const data = output.data as Float32Array;
	if (data.length !== EMBEDDING_MODEL_DIMS) {
		throw new Error(`Expected a ${EMBEDDING_MODEL_DIMS}-dim embedding, got ${data.length}`);
	}
	return data;
}
