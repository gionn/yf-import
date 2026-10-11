/**
 * CORS support for the public API endpoints.
 *
 * Routes echo a request's `Origin` in `Access-Control-Allow-Origin` only on an
 * exact match with `ALLOWED_ORIGINS`, and always send `Vary: Origin` (merged
 * with any existing `Vary`, e.g. the details route's `Accept`) so shared caches
 * never reuse one origin's response for another. The allowlist is never
 * disclosed. Applied per-request after cache lookup, keeping cached bodies
 * origin-agnostic.
 */

/** Minimal env surface the CORS layer depends on. */
export interface CorsEnv {
	ALLOWED_ORIGINS?: string; // Comma-separated list of origins allowed for CORS
}

/**
 * Returns the request origin if present in ALLOWED_ORIGINS, else null. Only the
 * caller's own origin is echoed, so the list is never disclosed.
 */
function getAllowedOrigin(
	requestOrigin: string | null,
	env: CorsEnv,
): string | null {
	if (!requestOrigin) return null;

	const allowedOrigins = (env.ALLOWED_ORIGINS || "")
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean);

	return allowedOrigins.includes(requestOrigin) ? requestOrigin : null;
}

/**
 * Merges a token into an existing `Vary` header value without duplicating it.
 */
function appendVary(current: string | null, value: string): string {
	const values = (current || "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (!values.includes(value)) values.push(value);
	return values.join(", ");
}

/**
 * Adds CORS headers, cloning the response (cached/redirect responses have
 * immutable headers). `Vary: Origin` is always set (merged with any existing
 * `Vary` values, e.g. `Accept`) so caches never reuse one origin's response for
 * another; `Access-Control-Allow-Origin` is set only on a match.
 */
function withCors(response: Response, allowedOrigin: string | null): Response {
	const headers = new Headers(response.headers);
	headers.set("Vary", appendVary(headers.get("Vary"), "Origin"));
	if (allowedOrigin) {
		headers.set("Access-Control-Allow-Origin", allowedOrigin);
	}

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/**
 * Builds a CORS preflight (OPTIONS) response. The endpoints are public, so any
 * requested headers are accepted; the origin allowlist is the real gate.
 */
function corsPreflightResponse(
	request: Request,
	allowedOrigin: string | null,
): Response {
	const headers = new Headers({
		"Access-Control-Allow-Methods": "GET, OPTIONS",
		Vary: "Origin",
	});
	if (allowedOrigin) {
		headers.set("Access-Control-Allow-Origin", allowedOrigin);

		const requestedHeaders = request.headers.get(
			"Access-Control-Request-Headers",
		);
		if (requestedHeaders) {
			headers.set("Access-Control-Allow-Headers", requestedHeaders);
			headers.append("Vary", "Access-Control-Request-Headers");
		}
	}
	return new Response(null, { status: 204, headers });
}

/**
 * Resolves the CORS origin for a request and, for OPTIONS requests, the ready
 * preflight response. Shared by every route so CORS behaves identically.
 */
export function resolveCors(
	request: Request,
	env: CorsEnv,
): { allowedOrigin: string | null; preflight: Response | null } {
	const allowedOrigin = getAllowedOrigin(request.headers.get("Origin"), env);
	const preflight =
		request.method === "OPTIONS"
			? corsPreflightResponse(request, allowedOrigin)
			: null;

	return { allowedOrigin, preflight };
}

/**
 * Runs a route handler, wrapping any thrown error in an `errorResponse(message)`
 * (typically a `500 no-store`) and adding CORS headers to every outcome,
 * including errors. `errorLabel` names the operation (e.g. `quote`, `details`).
 */
export async function corsGuarded(
	handler: () => Promise<Response>,
	allowedOrigin: string | null,
	errorLabel: string,
	errorResponse: (message: string) => Response,
): Promise<Response> {
	try {
		return withCors(await handler(), allowedOrigin);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		return withCors(
			errorResponse(`Error fetching ${errorLabel}: ${message}`),
			allowedOrigin,
		);
	}
}
