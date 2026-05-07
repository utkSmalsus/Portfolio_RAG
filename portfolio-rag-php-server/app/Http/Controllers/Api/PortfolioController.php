<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\DocumentTextExtractor;
use App\Services\HuggingFaceService;
use App\Services\QdrantService;
use App\Support\TextChunker;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

class PortfolioController extends Controller
{
    private const COLLECTION = 'portfolio-docs';

    public function collection(QdrantService $qdrant): JsonResponse
    {
        try {
            if (!$qdrant->collectionExists(self::COLLECTION)) {
                return response()->json(['exists' => false, 'points' => 0, 'sources' => []]);
            }
            $points = $qdrant->getCollectionPointCount(self::COLLECTION);
            $sources = $qdrant->scrollSources(self::COLLECTION, 100);
            return response()->json(['exists' => true, 'points' => $points, 'sources' => $sources]);
        } catch (\Throwable $e) {
            return response()->json(['exists' => false, 'points' => 0, 'sources' => [], 'offline' => true]);
        }
    }

    public function deleteCollection(QdrantService $qdrant): JsonResponse
    {
        try {
            if (!$qdrant->collectionExists(self::COLLECTION)) {
                return response()->json(['success' => true, 'message' => 'No collection to delete.']);
            }
            $qdrant->deleteCollection(self::COLLECTION);
            return response()->json(['success' => true, 'message' => 'Collection deleted successfully.']);
        } catch (\Throwable $e) {
            return response()->json(['success' => false, 'message' => $e->getMessage() ?: 'Failed to delete collection'], 500);
        }
    }

    public function index(
        Request $request,
        DocumentTextExtractor $extractor,
        HuggingFaceService $hf,
        QdrantService $qdrant
    ): JsonResponse {
        try {
            set_time_limit(0);
            $files = $request->file('pdf', []);
            if (!is_array($files)) $files = [$files];
            if (count($files) === 0) {
                return response()->json(['success' => false, 'message' => 'No PDF file uploaded.'], 400);
            }

            $sources = [];
            $allChunks = [];

            foreach ($files as $file) {
                if (!$file) continue;
                if ($file->getClientMimeType() !== 'application/pdf') {
                    return response()->json(['success' => false, 'message' => 'Please select only PDF files.'], 400);
                }
                $path = $file->getRealPath();
                if (!$path || !is_file($path)) {
                    return response()->json(['success' => false, 'message' => 'Uploaded PDF temporary file is not available. Please re-upload.'], 400);
                }
                $label = $file->getClientOriginalName() ?: basename($path);
                $sources[] = $label;

                $text = $extractor->extractPdf($path);
                $chunks = TextChunker::chunk($text);
                foreach ($chunks as $c) {
                    $allChunks[] = ['text' => $c, 'source' => $label];
                }
            }

            if (count($allChunks) === 0) {
                return response()->json(['success' => false, 'message' => 'No text found in uploaded PDFs.'], 500);
            }

            // Determine embedding dim from first chunk and ensure collection exists.
            $v0 = $hf->embed($allChunks[0]['text']);
            if (count($v0) === 0) {
                return response()->json(['success' => false, 'message' => 'Embedding failed. Check HUGGINGFACE_API_KEY / model access.'], 500);
            }
            $qdrant->ensureCollection(self::COLLECTION, count($v0));

            $points = [];
            foreach ($allChunks as $idx => $chunk) {
                $vec = $idx === 0 ? $v0 : $hf->embed($chunk['text']);
                if (count($vec) === 0) continue;
                $points[] = [
                    'id' => (string) Str::uuid(),
                    'vector' => $vec,
                    'payload' => [
                        'text' => $chunk['text'],
                        'metadata' => ['source' => $chunk['source']],
                    ],
                ];
            }

            $qdrant->upsert(self::COLLECTION, $points);

            return response()->json([
                'success' => true,
                'message' => 'Indexed '.count($sources).' PDF(s) ('.count($points).' chunks).',
                'chunks' => count($points),
                'pdfCount' => count($sources),
                'sources' => $sources,
                'mode' => 'created',
            ]);
        } catch (\Throwable $e) {
            return response()->json([
                'success' => false,
                'message' => $e->getMessage() ?: 'Indexing failed.',
            ], 500);
        }
    }
}

