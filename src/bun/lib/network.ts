// Multiple fallbacks — parallel race so one blocked URL doesn't add latency.
const PROBE_URLS = [
	"https://www.google.com",
	"https://connectivitycheck.gstatic.com/generate_204",
	"https://www.cloudflare.com",
];

/** Lightweight real-internet probe — runs from Bun (no CORS/WebView restrictions). */
export async function isNetworkAvailable(): Promise<boolean> {
	const probes = PROBE_URLS.map((url) =>
		fetch(url, { method: "HEAD", signal: AbortSignal.timeout(4000) }).then((res) => {
			if (res.status >= 500) throw new Error(`${res.status}`);
			return true;
		}),
	);
	// Resolve true as soon as the first probe succeeds; false only when all fail.
	return new Promise<boolean>((resolve) => {
		let remaining = PROBE_URLS.length;
		const fail = () => { if (--remaining === 0) resolve(false); };
		for (const p of probes) p.then(() => resolve(true)).catch(fail);
	});
}
