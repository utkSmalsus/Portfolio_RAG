<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\DocumentTextExtractor;
use App\Services\HuggingFaceService;
use App\Services\QdrantService;
use App\Support\TextChunker;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Arr;
use Illuminate\Support\Str;

class TranscriptController extends Controller
{
    private const COLLECTION = 'transcript-docs';
    private const FEEDBACK_COLLECTION = 'transcript-feedback';

    public function collection(QdrantService $qdrant): JsonResponse
    {
        try {
            if (!$qdrant->collectionExists(self::COLLECTION)) {
                return response()->json(['exists' => false, 'points' => 0, 'sources' => []]);
            }
            $points = $qdrant->getCollectionPointCount(self::COLLECTION);
            $sources = $qdrant->scrollSources(self::COLLECTION, 100);
            return response()->json(['exists' => true, 'points' => $points, 'sources' => $sources]);
        } catch (\Throwable) {
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
                return response()->json(['success' => false, 'message' => 'No transcript file uploaded.'], 400);
            }

            $sources = [];
            $allChunks = [];

            foreach ($files as $file) {
                if (!$file) continue;
                $name = $file->getClientOriginalName() ?: 'document';
                $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
                $isPdf = $file->getClientMimeType() === 'application/pdf' || $ext === 'pdf';
                $isDocx = $ext === 'docx';
                if (!$isPdf && !$isDocx) {
                    return response()->json(['success' => false, 'message' => 'Please select only PDF or DOCX files.'], 400);
                }

                $path = $file->getRealPath();
                if (!$path || !is_file($path)) {
                    return response()->json(['success' => false, 'message' => 'Uploaded file temporary path is not available. Please re-upload.'], 400);
                }
                $label = $name;
                $sources[] = $label;

                $text = $isDocx ? $extractor->extractDocx($path) : $extractor->extractPdf($path);
                $chunks = TextChunker::chunk($text);
                foreach ($chunks as $c) {
                    $allChunks[] = ['text' => $c, 'source' => $label];
                }
            }

            if (count($allChunks) === 0) {
                return response()->json(['success' => false, 'message' => 'No text found in uploaded transcript files.'], 500);
            }

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
                'message' => 'Indexed '.count($sources).' transcript(s) ('.count($points).' chunks).',
                'sources' => $sources,
            ]);
        } catch (\Throwable $e) {
            return response()->json([
                'success' => false,
                'message' => $e->getMessage() ?: 'Transcript indexing failed.',
            ], 500);
        }
    }

    public function chat(Request $request, HuggingFaceService $hf, QdrantService $qdrant): JsonResponse
    {
        $q = (string) ($request->input('question') ?? '');
        $q = trim($q);
        if ($q === '') return response()->json(['error' => "Missing or invalid 'question' in body"], 400);

        $vec = $hf->embed($q);
        if (count($vec) === 0) return response()->json(['error' => 'Embedding failed'], 500);

        $results = $qdrant->collectionExists(self::COLLECTION)
            ? $qdrant->search(self::COLLECTION, $vec, 5)
            : [];

        $context = collect($results)->map(fn($r) => (string) Arr::get($r, 'payload.text', ''))->filter()->implode("\n\n");
        if ($context === '') {
            return response()->json(['answer' => "No transcript data found. Please index a PDF first using 'Upload PDF'.", 'recommendation' => null]);
        }

        $system = "You are a helpful assistant that summarizes meeting transcripts and extracts action items.";
        $user = "USER QUESTION:\n{$q}\n\nRETRIEVED TRANSCRIPT CONTEXT:\n{$context}";
        $answer = $hf->chat($system, $user, 1200);

        return response()->json(['answer' => $answer, 'recommendation' => null]);
    }

    public function feedback(Request $request, QdrantService $qdrant, HuggingFaceService $hf): JsonResponse
    {
        $question = (string) $request->input('question');
        $answer = (string) $request->input('answer');
        $isPositive = $request->input('isPositive');
        $correction = (string) $request->input('correction');

        if ($question === '' || $isPositive === null) {
            return response()->json(['error' => 'Missing required feedback fields'], 400);
        }

        if ($isPositive === false || $isPositive === 'false' || $isPositive === 0 || $isPositive === '0') {
            if ($correction !== '') {
                $vec = $hf->embed($question);
                if (count($vec) > 0) {
                    $qdrant->ensureCollection(self::FEEDBACK_COLLECTION, count($vec));
                    $qdrant->upsert(self::FEEDBACK_COLLECTION, [[
                        'id' => (string) Str::uuid(),
                        'vector' => $vec,
                        'payload' => [
                            'text' => $correction,
                            'metadata' => [
                                'question' => $question,
                                'originalAnswer' => $answer,
                                'timestamp' => now()->toISOString(),
                            ],
                        ],
                    ]]);
                }
            }
        }

        return response()->json(['success' => true, 'message' => 'Feedback saved. AI will learn from this.']);
    }
}

