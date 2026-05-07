<?php

namespace App\Services;

use GuzzleHttp\Client;
use Illuminate\Support\Arr;

class QdrantService
{
    private Client $http;
    private string $baseUrl;
    private ?string $apiKey;

    public function __construct()
    {
        $this->baseUrl = rtrim((string) config('services.qdrant.url'), '/');
        $this->apiKey = config('services.qdrant.api_key') ? trim((string) config('services.qdrant.api_key')) : null;
        $this->http = new Client([
            'base_uri' => $this->baseUrl.'/',
            'timeout' => 60,
        ]);
    }

    private function headers(): array
    {
        $h = ['Accept' => 'application/json'];
        if ($this->apiKey) {
            $h['api-key'] = $this->apiKey;
        }
        return $h;
    }

    public function collectionExists(string $name): bool
    {
        try {
            $r = $this->http->get("collections/{$name}", ['headers' => $this->headers()]);
            return $r->getStatusCode() >= 200 && $r->getStatusCode() < 300;
        } catch (\Throwable) {
            return false;
        }
    }

    public function getCollectionPointCount(string $name): int
    {
        $r = $this->http->get("collections/{$name}", ['headers' => $this->headers()]);
        $body = json_decode((string) $r->getBody(), true) ?: [];
        return (int) Arr::get($body, 'result.points_count', 0);
    }

    public function deleteCollection(string $name): void
    {
        $this->http->delete("collections/{$name}", ['headers' => $this->headers()]);
    }

    public function ensureCollection(string $name, int $vectorSize): void
    {
        if ($this->collectionExists($name)) return;

        $this->http->put("collections/{$name}", [
            'headers' => array_merge($this->headers(), ['Content-Type' => 'application/json']),
            'json' => [
                'vectors' => [
                    'size' => $vectorSize,
                    'distance' => 'Cosine',
                ],
            ],
        ]);
    }

    public function upsert(string $collection, array $points): void
    {
        $this->http->put("collections/{$collection}/points?wait=true", [
            'headers' => array_merge($this->headers(), ['Content-Type' => 'application/json']),
            'json' => ['points' => $points],
        ]);
    }

    public function scrollSources(string $collection, int $limit = 100): array
    {
        $r = $this->http->post("collections/{$collection}/points/scroll", [
            'headers' => array_merge($this->headers(), ['Content-Type' => 'application/json']),
            'json' => [
                'limit' => $limit,
                'with_payload' => true,
                'with_vector' => false,
            ],
        ]);
        $body = json_decode((string) $r->getBody(), true) ?: [];
        $points = Arr::get($body, 'result.points', []);
        $set = [];
        foreach ($points as $pt) {
            $src = Arr::get($pt, 'payload.metadata.source') ?? Arr::get($pt, 'payload.source');
            if ($src) $set[$src] = true;
        }
        return array_values(array_keys($set));
    }

    public function search(string $collection, array $vector, int $limit = 5): array
    {
        $r = $this->http->post("collections/{$collection}/points/search", [
            'headers' => array_merge($this->headers(), ['Content-Type' => 'application/json']),
            'json' => [
                'vector' => $vector,
                'limit' => $limit,
                'with_payload' => true,
                'with_vector' => false,
            ],
        ]);
        $body = json_decode((string) $r->getBody(), true) ?: [];
        return Arr::get($body, 'result', []);
    }
}

