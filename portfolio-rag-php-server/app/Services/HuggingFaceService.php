<?php

namespace App\Services;

use GuzzleHttp\Client;
use Illuminate\Support\Arr;

class HuggingFaceService
{
    private Client $apiInference;
    private Client $routerInference;
    private Client $routerOpenAI;
    private string $apiKey;
    private string $embeddingModel;
    private string $chatModel;
    private bool $useRemoteEmbeddings;

    public function __construct()
    {
        $this->apiKey = trim((string) config('services.huggingface.api_key'));
        $this->embeddingModel = (string) config('services.huggingface.embedding_model');
        $this->chatModel = (string) config('services.huggingface.chat_model');
        $this->useRemoteEmbeddings = (bool) config('services.huggingface.use_remote_embeddings', false);
        $this->apiInference = new Client([
            'base_uri' => 'https://api-inference.huggingface.co/',
            'timeout' => 8,
            'connect_timeout' => 3,
        ]);
        $this->routerInference = new Client([
            'base_uri' => 'https://router.huggingface.co/hf-inference/',
            'timeout' => 8,
            'connect_timeout' => 3,
        ]);
        $this->routerOpenAI = new Client([
            'base_uri' => 'https://router.huggingface.co/',
            'timeout' => 8,
            'connect_timeout' => 3,
        ]);
    }

    private function headers(): array
    {
        return [
            'Accept' => 'application/json',
            'Authorization' => "Bearer {$this->apiKey}",
            'Content-Type' => 'application/json',
        ];
    }

    /** @return float[] */
    public function embed(string $text): array
    {
        if (!$this->useRemoteEmbeddings) {
            return $this->localDeterministicEmbedding($text, 384);
        }

        $modelId = rawurlencode($this->embeddingModel);
        $openAiLikePayload = [
            'model' => $this->embeddingModel,
            'input' => $text,
        ];
        $payload = [
            'inputs' => $text,
            'options' => [
                'wait_for_model' => true,
            ],
        ];

        $attempts = [
            [$this->routerOpenAI, 'v1/embeddings', $openAiLikePayload],
            [$this->apiInference, "models/{$modelId}"],
            [$this->apiInference, "pipeline/feature-extraction/{$modelId}"],
            [$this->routerInference, "models/{$modelId}"],
            [$this->routerInference, "pipeline/feature-extraction/{$modelId}"],
        ];

        $lastError = null;
        foreach ($attempts as $attempt) {
            [$client, $path] = $attempt;
            $jsonPayload = $attempt[2] ?? $payload;
            try {
                $r = $client->post($path, [
                    'headers' => $this->headers(),
                    'json' => $jsonPayload,
                    'http_errors' => false,
                ]);
                $status = $r->getStatusCode();
                $body = json_decode((string) $r->getBody(), true);
                if ($status >= 400) {
                    $snippet = substr((string) $r->getBody(), 0, 180);
                    $lastError = "HF embedding endpoint failed: {$path} (HTTP {$status}) {$snippet}";
                    continue;
                }
                if (!is_array($body)) {
                    $lastError = "HF embedding endpoint returned invalid JSON: {$path}";
                    continue;
                }
                $vector = $path === 'v1/embeddings'
                    ? array_map('floatval', (array) Arr::get($body, 'data.0.embedding', []))
                    : $this->normalizeEmbeddingResponse($body);
                if (count($vector) > 0) return $vector;
                $lastError = "HF embedding endpoint returned empty vector: {$path}";
            } catch (\Throwable $e) {
                $lastError = $e->getMessage();
            }
        }

        // Fallback: keep the app functional even when HF provider/model combo
        // does not support embeddings. This is deterministic, so retrieval still works.
        return $this->localDeterministicEmbedding($text, 384);
    }

    /** @param mixed[] $body @return float[] */
    private function normalizeEmbeddingResponse(array $body): array
    {
        // Common shapes:
        // - [dim]
        // - [[dim]] or [[...],[...]] token embeddings
        if (isset($body[0]) && is_numeric($body[0])) {
            return array_map('floatval', $body);
        }
        if (isset($body[0]) && is_array($body[0])) {
            // mean pool if token embeddings
            $vectors = $body;
            $dim = count($vectors[0] ?? []);
            if ($dim <= 0) return [];
            $sum = array_fill(0, $dim, 0.0);
            $n = 0;
            foreach ($vectors as $v) {
                if (!is_array($v) || count($v) !== $dim) continue;
                for ($i = 0; $i < $dim; $i++) $sum[$i] += (float) $v[$i];
                $n++;
            }
            if ($n <= 0) return [];
            for ($i = 0; $i < $dim; $i++) $sum[$i] /= $n;
            return $sum;
        }
        return [];
    }

    /** @return float[] */
    private function localDeterministicEmbedding(string $text, int $dims = 384): array
    {
        $vec = array_fill(0, $dims, 0.0);
        $tokens = preg_split('/\s+/', mb_strtolower(trim($text))) ?: [];
        foreach ($tokens as $tok) {
            if ($tok === '') continue;
            // crc32 may behave as signed/unsigned across platforms; normalize to int.
            $h = crc32($tok);
            $hInt = (int) sprintf('%u', $h);
            $idx = $hInt % $dims;
            $sign = ((($hInt >> 1) & 1) === 1) ? 1.0 : -1.0;
            $vec[$idx] += $sign;
        }
        $norm = 0.0;
        foreach ($vec as $v) {
            $norm += $v * $v;
        }
        $norm = sqrt($norm);
        if ($norm > 0.0) {
            for ($i = 0; $i < $dims; $i++) {
                $vec[$i] /= $norm;
            }
        }
        return $vec;
    }

    public function chat(string $system, string $user, int $maxTokens = 800): string
    {
        $payload = [
            'model' => $this->chatModel,
            'messages' => [
                ['role' => 'system', 'content' => $system],
                ['role' => 'user', 'content' => $user],
            ],
            'max_tokens' => $maxTokens,
            'temperature' => 0,
        ];

        $attempts = [
            [$this->routerOpenAI, 'v1/chat/completions', $payload],
            [$this->apiInference, 'v1/chat/completions', $payload],
        ];

        $lastError = null;
        foreach ($attempts as [$client, $path, $json]) {
            try {
                $r = $client->post($path, [
                    'headers' => $this->headers(),
                    'json' => $json,
                    'http_errors' => false,
                ]);
                $status = $r->getStatusCode();
                $raw = (string) $r->getBody();
                $body = json_decode($raw, true) ?: [];
                if ($status >= 400) {
                    $msg = Arr::get($body, 'error.message')
                        ?? Arr::get($body, 'error')
                        ?? substr(strip_tags($raw), 0, 200);
                    $lastError = "HuggingFace chat failed via {$path} (HTTP {$status}): {$msg}";
                    continue;
                }
                $answer = trim((string) Arr::get($body, 'choices.0.message.content', ''));
                if ($answer !== '') return $answer;
                $lastError = "HuggingFace chat returned empty content via {$path}";
            } catch (\Throwable $e) {
                $lastError = $e->getMessage();
            }
        }

        // Friendly fallback so chat never crashes completely.
        return "I could not reach the configured Hugging Face chat endpoint right now. "
            ."Your indexing is working; please retry in a moment or switch to a supported chat model/provider."
            .($lastError ? " ({$lastError})" : "");
    }
}

