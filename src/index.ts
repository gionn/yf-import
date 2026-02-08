export interface Env {
	// Define your environment variables here
	// Example: KV namespace, secrets, etc.
}

async function getYahooQuote(symbol: string): Promise<number | null> {
	const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`;
	
	const response = await fetch(url, {
		headers: {
			'User-Agent': 'Mozilla/5.0',
		},
	});
	
	if (!response.ok) {
		throw new Error(`Yahoo Finance API error: ${response.status}`);
	}
	
	const data = await response.json() as any;
	const result = data?.chart?.result?.[0];
	const price = result?.meta?.regularMarketPrice;
	
	return price ?? null;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		
		// Handle /api/quotes/:symbol endpoint
		const match = url.pathname.match(/^\/api\/quotes\/([^\/]+)$/);
		if (match) {
			const symbol = match[1];
			
			try {
				const price = await getYahooQuote(symbol);
				
				if (price === null) {
					return new Response('Price not available', { 
						status: 404,
						headers: {
							'Content-Type': 'text/plain',
						},
					});
				}
				
				return new Response(price.toString(), {
					status: 200,
					headers: {
						'Content-Type': 'text/plain',
					},
				});
			} catch (error) {
				return new Response(`Error fetching quote: ${error instanceof Error ? error.message : 'Unknown error'}`, {
					status: 500,
					headers: {
						'Content-Type': 'text/plain',
					},
				});
			}
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
