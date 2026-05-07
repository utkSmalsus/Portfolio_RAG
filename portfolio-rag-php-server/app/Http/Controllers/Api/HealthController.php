<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;

class HealthController extends Controller
{
    public function show(): JsonResponse
    {
        $qdrantUrl = trim((string) config('services.qdrant.url', env('QDRANT_URL', 'http://localhost:6333')));
        $host = parse_url($qdrantUrl, PHP_URL_HOST) ?: $qdrantUrl;

        return response()->json([
            'ok' => true,
            'qdrantHost' => $host,
            'qdrantApiKeySet' => (bool) env('QDRANT_API_KEY'),
            'huggingFaceKeySet' => (bool) env('HUGGINGFACE_API_KEY'),
            'chatModel' => (string) env('HF_CHAT_MODEL', 'Qwen/Qwen2.5-7B-Instruct'),
        ]);
    }
}

