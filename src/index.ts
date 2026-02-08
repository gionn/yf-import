export interface Env {
	// Define your environment variables here
	// Example: KV namespace, secrets, etc.
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		
		// Handle /api/quotes/VWCE endpoint
		if (url.pathname === '/api/quotes/VWCE') {
			return new Response('42', {
				status: 200,
				headers: {
					'Content-Type': 'text/plain',
				},
			});
		}
		
		// Handle 404 for other routes
		return new Response('Not Found', { 
			status: 404,
			headers: {
				'Content-Type': 'text/plain',
			},
		});
	},
};
