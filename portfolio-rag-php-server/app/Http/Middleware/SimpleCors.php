<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class SimpleCors
{
    public function handle(Request $request, Closure $next)
    {
        $origin = $request->headers->get('Origin');
        $allowed = array_values(array_filter([
            config('app.frontend_url'),
            'http://localhost:5173',
            'http://127.0.0.1:5173',
        ]));

        // Preflight request should always return quickly with CORS headers.
        if ($request->getMethod() === 'OPTIONS') {
            $response = response('', 204);
            return $this->applyCors($response, $origin, $allowed);
        }

        try {
            $response = $next($request);
        } catch (\Throwable $e) {
            // Ensure frontend always receives JSON + CORS headers even on failures.
            $response = response()->json([
                'success' => false,
                'message' => $e->getMessage() ?: 'Internal Server Error',
            ], 500);
        }

        return $this->applyCors($response, $origin, $allowed);
    }

    private function applyCors(Response $response, ?string $origin, array $allowed): Response
    {
        if ($origin && in_array($origin, $allowed, true)) {
            $response->headers->set('Access-Control-Allow-Origin', $origin);
            $response->headers->set('Vary', 'Origin');
            $response->headers->set('Access-Control-Allow-Credentials', 'true');
            $response->headers->set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            $response->headers->set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        }
        return $response;
    }
}

