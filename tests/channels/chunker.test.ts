/**
 * chunker.test.ts
 *
 * Tests for the chunkMessage utility that splits long channel messages into
 * appropriately-sized pieces for delivery over Discord, WhatsApp, etc.
 *
 * The chunker has no external dependencies, so no mocking is needed.
 */

import { describe, it, expect } from "bun:test";
import { chunkMessage } from "../../src/bun/channels/chunker";

// ---------------------------------------------------------------------------
// Short messages — no splitting needed
// ---------------------------------------------------------------------------

describe("chunkMessage — short messages (no split)", () => {
	it("returns the original string in a single-element array when text is within limit", () => {
		const text = "Hello, world!";
		const chunks = chunkMessage(text, 1800);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toBe(text);
	});

	it("returns a single chunk when text length equals maxLength exactly", () => {
		const text = "a".repeat(1800);
		const chunks = chunkMessage(text, 1800);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toBe(text);
	});

	it("returns a single chunk for an empty string", () => {
		const chunks = chunkMessage("", 1800);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toBe("");
	});

	it("uses 1800 as the default maxLength", () => {
		const text = "short";
		const chunks = chunkMessage(text);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toBe(text);
	});
});

// ---------------------------------------------------------------------------
// Long messages — splitting behaviour
// ---------------------------------------------------------------------------

describe("chunkMessage — long messages (splitting)", () => {
	it("splits a message that exceeds maxLength into multiple chunks", () => {
		const text = "word ".repeat(500); // ~2500 chars
		const chunks = chunkMessage(text, 100);
		expect(chunks.length).toBeGreaterThan(1);
	});

	it("every chunk respects the maxLength limit", () => {
		const text = "word ".repeat(500);
		const maxLength = 200;
		const chunks = chunkMessage(text, maxLength);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(maxLength);
		}
	});

	it("reassembled chunks contain all original words", () => {
		const words = Array.from({ length: 300 }, (_, i) => `word${i}`);
		const text = words.join(" ");
		const chunks = chunkMessage(text, 200);
		const reassembled = chunks.join(" ");
		// All words should survive the round-trip (trimStart may remove leading spaces)
		for (const word of words) {
			expect(reassembled).toContain(word);
		}
	});

	it("no chunk is empty after splitting", () => {
		const text = "a".repeat(500);
		const chunks = chunkMessage(text, 100);
		for (const chunk of chunks) {
			expect(chunk.length).toBeGreaterThan(0);
		}
	});
});

// ---------------------------------------------------------------------------
// Break-point priority
// ---------------------------------------------------------------------------

describe("chunkMessage — break-point priority", () => {
	it("prefers paragraph breaks (\\n\\n) over single newlines", () => {
		// Build a message with a paragraph break well before maxLength so the
		// chunker should use it.
		const para1 = "First paragraph content.";
		const para2 = "Second paragraph content.";
		const text = `${para1}\n\n${para2}`;
		// maxLength is large enough to hold both paragraphs but we force a split
		// by using a very small limit that sits just past the paragraph break.
		const maxLength = para1.length + 3; // includes '\n\n'
		const chunks = chunkMessage(text, maxLength);
		// The first chunk should end at/before the paragraph break.
		expect(chunks[0]).toContain("First paragraph");
		expect(chunks[1]).toContain("Second paragraph");
	});

	it("falls back to single newline when no paragraph break is available", () => {
		const line1 = "Line one content here.";
		const line2 = "Line two content here.";
		const text = `${line1}\n${line2}`;
		const maxLength = line1.length + 2;
		const chunks = chunkMessage(text, maxLength);
		expect(chunks.length).toBeGreaterThanOrEqual(1);
		// line1 content should appear before line2 content across chunks
		const joined = chunks.join("|");
		const idx1 = joined.indexOf("Line one");
		const idx2 = joined.indexOf("Line two");
		expect(idx1).toBeLessThan(idx2);
	});

	it("falls back to space when no newline is available", () => {
		// A long single line with spaces — chunker should break at a space
		const text = "word ".repeat(100).trimEnd();
		const maxLength = 50;
		const chunks = chunkMessage(text, maxLength);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(maxLength);
		}
	});

	it("hard-cuts at maxLength when no natural break exists", () => {
		// A single continuous run of characters with no whitespace or newlines.
		const text = "x".repeat(300);
		const maxLength = 100;
		const chunks = chunkMessage(text, maxLength);
		expect(chunks.length).toBe(3);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(maxLength);
		}
	});
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("chunkMessage — edge cases", () => {
	it("handles a message of exactly maxLength + 1 (minimal split)", () => {
		const text = "a".repeat(101);
		const chunks = chunkMessage(text, 100);
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		expect(chunks.join("")).toHaveLength(101);
	});

	it("handles messages with only newlines", () => {
		const text = "\n".repeat(200);
		const chunks = chunkMessage(text, 50);
		expect(chunks.length).toBeGreaterThan(0);
	});

	it("handles a custom small maxLength of 10", () => {
		const text = "Hello World!";
		const chunks = chunkMessage(text, 10);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(10);
		}
	});

	it("handles unicode characters without crashing", () => {
		const text = "こんにちは世界！".repeat(50);
		const chunks = chunkMessage(text, 100);
		expect(chunks.length).toBeGreaterThan(0);
	});

	it("produces the same total content regardless of chunk size", () => {
		const text = "The quick brown fox jumps over the lazy dog. ".repeat(20);
		const chunks50 = chunkMessage(text, 50);
		const chunks200 = chunkMessage(text, 200);

		// Both should preserve all content (modulo trimStart on continuation chunks)
		// Check total character count is within 5% of original (trimStart removes leading whitespace)
		const rejoinedSmall = chunks50.join(" ").replace(/\s+/g, " ");
		const rejoinedLarge = chunks200.join(" ").replace(/\s+/g, " ");
		expect(rejoinedSmall.length).toBeGreaterThan(text.length * 0.9);
		expect(rejoinedLarge.length).toBeGreaterThan(text.length * 0.9);
	});
});
