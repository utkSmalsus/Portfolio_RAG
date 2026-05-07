<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\HuggingFaceService;
use App\Services\QdrantService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Arr;

class UnifiedChatController extends Controller
{
    private const PORTFOLIO_COLLECTION = 'portfolio-docs';
    private const TRANSCRIPT_COLLECTION = 'transcript-docs';
    private const TRANSCRIPT_QUERY_RE = '/\b(transcript|meeting|call notes|minutes|action items?|summary|summarize|summarise)\b/i';

    public function chat(Request $request, HuggingFaceService $hf, QdrantService $qdrant): JsonResponse
    {
        try {
            $question = (string) ($request->input('question') ?? '');
            $question = trim($question);
            $mode = strtolower(trim((string) ($request->input('mode') ?? '')));
            if ($question === '') {
                return response()->json(['error' => "Missing or invalid 'question' in body"], 400);
            }

            $vec = $hf->embed($question);
            if (count($vec) === 0) {
                return response()->json(['error' => 'Embedding failed. Check HUGGINGFACE_API_KEY / model access.'], 500);
            }

            $expandedQuestion = "User is logging a work item (e.g., EOD report, bug fix, development task).\n\nTask Description:\n\"{$question}\"\n\nInterpret this as actual work done and map it to the most relevant project/sprint/cycle.";
            $portfolioVec = $hf->embed($expandedQuestion);

            $portfolioHits = $qdrant->collectionExists(self::PORTFOLIO_COLLECTION)
                ? $qdrant->search(self::PORTFOLIO_COLLECTION, $vec, 7)
                : [];
            $transcriptHits = $qdrant->collectionExists(self::TRANSCRIPT_COLLECTION)
                ? $qdrant->search(self::TRANSCRIPT_COLLECTION, $vec, 5)
                : [];

            $pContext = collect($portfolioHits)->map(fn($r) => (string) Arr::get($r, 'payload.text', ''))->filter()->implode("\n\n");
            $tContext = collect($transcriptHits)->map(fn($r) => (string) Arr::get($r, 'payload.text', ''))->filter()->implode("\n\n");

            $forceTranscript = $mode === 'transcript';
            $forcePortfolio = $mode === 'portfolio';

            if (!$forcePortfolio && ($forceTranscript || $this->isTranscriptQuery($question)) && trim($tContext) !== '') {
                $answer = $this->buildTranscriptSummary($hf, $question, $tContext);
                return response()->json([
                    'answer' => $answer,
                    'recommendation' => null,
                    'tasks' => [],
                ]);
            }

            if ($forceTranscript && trim($tContext) === '') {
                return response()->json([
                    'answer' => "No transcript data found. Please upload transcript files first.",
                    'recommendation' => null,
                    'tasks' => [],
                ]);
            }

            if ($forcePortfolio && trim($pContext) === '') {
                return response()->json([
                    'answer' => "No portfolio data found. Please upload portfolio PDF first.",
                    'recommendation' => null,
                    'tasks' => [],
                ]);
            }

            $portfolio = $this->buildPortfolioMatch($hf, $question, $pContext, $portfolioHits);
            return response()->json([
                'answer' => $portfolio['answer'],
                'recommendation' => $portfolio['recommendation'],
                'tasks' => [],
            ]);
        } catch (\Throwable $e) {
            return response()->json([
                'error' => $e->getMessage() ?: 'Unified chat failed',
            ], 500);
        }
    }

    private function isTranscriptQuery(string $q): bool
    {
        return preg_match(self::TRANSCRIPT_QUERY_RE, $q) === 1;
    }

    /** @param array<int, array<string,mixed>> $portfolioHits
     *  @return array{answer:string,recommendation:array<string,mixed>|null}
     */
    private function buildPortfolioMatch(HuggingFaceService $hf, string $question, string $portfolioContext, array $portfolioHits): array
    {
        if (trim($portfolioContext) === '') {
            return [
                'answer' => "No portfolio data found. Please index a portfolio PDF first using 'Upload Portfolio PDF'.",
                'recommendation' => [
                    'best_match' => [
                        'id' => null,
                        'title' => null,
                        'reason' => 'No portfolio matches in indexed context.',
                    ],
                    'alternatives' => [],
                ],
            ];
        }

        $structuredSystem = "Return valid JSON only, no markdown.";
        
        $structuredUser = <<<EOT
You are a strict portfolio tagging engine.
Given one task and candidate portfolio context, return ONLY JSON:
{
  "best_match": { "id": "P... or null", "title": "exact title or null", "reason": "short reason", "confidence": "high|medium|low" },
  "alternatives": [{ "id": "P...", "title": "exact title", "reason": "short reason" }],
  "needs_new_portfolio": true or false,
  "new_portfolio_suggestion": "short suggestion if needs_new_portfolio=true else empty string"
}

Rules:
- Use only candidate context.
- If no clearly relevant match, set best_match.id=null, alternatives=[] and needs_new_portfolio=true.
- Return max 2 alternatives.
- Prefer specific hierarchy: Cycle > Sprint > Project.

Task:
Title: {$question}
Description: {$question}

Candidate Portfolio Context:
{$portfolioContext}
EOT;

        $raw = $hf->chat($structuredSystem, $structuredUser, 700);

        $parsed = $this->parsePortfolioRecommendation($raw);
        $best = $parsed['best_match']['id'] ?? null;
        $bestTitle = $parsed['best_match']['title'] ?? $best;
        $bestReason = $parsed['best_match']['reason'] ?? 'Closest semantic match from retrieved portfolio context.';
        $altIds = [];
        foreach (($parsed['alternatives'] ?? []) as $alt) {
            if (!empty($alt['id'])) $altIds[] = (string) $alt['id'];
        }

        // Fallback to top retrieval hit when model JSON is missing/invalid.
        if (!$best) {
            $topText = (string) Arr::get($portfolioHits, '0.payload.text', '');
            $topId = $this->extractBestPortfolioId($topText ?: $portfolioContext);
            $best = $topId;
            $bestTitle = $topId;
            $bestReason = $topId
                ? 'Best match selected from top retrieved portfolio chunk.'
                : 'No explicit portfolio ID found.';
        }
        if (!$altIds) {
            $altIds = $this->extractAlternativeIds($portfolioContext, (string) $best);
        }

        $answerSystem = "You are a high-precision portfolio tagging assistant.
Write concise output:
1) Short Answer
2) Why the best portfolio match fits
3) Alternatives (if any)
Use only the given context.";
        $expandedQuestion = "User is logging a work item (e.g., EOD report, bug fix, development task).\n\nTask Description:\n\"{$question}\"\n\nInterpret this as actual work done and map it to the most relevant project/sprint/cycle.";
        $answerUser = "USER TASK:\n{$expandedQuestion}\n\nBEST MATCH ID: ".($best ?: 'N/A')."\nBEST MATCH TITLE: ".($bestTitle ?: 'N/A')."\nBEST MATCH REASON: {$bestReason}\n\nPORTFOLIO CONTEXT:\n{$portfolioContext}";
        $answer = $hf->chat($answerSystem, $answerUser, 800);
        if (str_starts_with(ltrim($answer), '<!DOCTYPE html')) {
            throw new \RuntimeException('Upstream provider returned HTML instead of chat response.');
        }

        return [
            'answer' => $answer !== '' ? $answer : 'Portfolio match generated.',
            'recommendation' => [
                'best_match' => [
                    'id' => $best,
                    'title' => $bestTitle,
                    'reason' => $bestReason,
                ],
                'alternatives' => $altIds,
            ],
        ];
    }

    private function buildTranscriptSummary(HuggingFaceService $hf, string $question, string $transcriptContext): string
    {
        $system = "You are a transcript summarization assistant.
Always output exactly:
Call summary
<multi-paragraph summary>

Consolidated Action Items
- <action item 1>
- <action item 2>

Rules:
- Use only transcript context.
- No hallucination.
- Keep action items concrete and execution-ready.";
        $user = "USER QUESTION:\n{$question}\n\nRETRIEVED TRANSCRIPT CONTEXT:\n{$transcriptContext}";
        $answer = $hf->chat($system, $user, 1200);
        if (str_starts_with(ltrim($answer), '<!DOCTYPE html')) {
            throw new \RuntimeException('Upstream provider returned HTML instead of transcript summary response.');
        }
        return $answer !== '' ? $answer : "Call summary\nNo transcript summary generated.\n\nConsolidated Action Items\n- No action items extracted.";
    }

    /** @return array{best_match: array{id:?string,title:?string,reason:?string}, alternatives: array<int,array{id:?string,title:?string,reason:?string}>} */
    private function parsePortfolioRecommendation(string $raw): array
    {
        $default = [
            'best_match' => ['id' => null, 'title' => null, 'reason' => null],
            'alternatives' => [],
        ];
        $clean = trim(preg_replace('/^```(?:json)?|```$/mi', '', $raw) ?? '');
        if ($clean === '') return $default;
        if (!preg_match('/\{[\s\S]*\}/', $clean, $m)) return $default;
        $obj = json_decode($m[0], true);
        if (!is_array($obj)) return $default;
        $best = Arr::get($obj, 'best_match', []);
        $alts = Arr::get($obj, 'alternatives', []);
        return [
            'best_match' => [
                'id' => $best['id'] ?? null,
                'title' => $best['title'] ?? null,
                'reason' => $best['reason'] ?? null,
            ],
            'alternatives' => is_array($alts) ? array_values(array_filter(array_map(function ($a) {
                if (!is_array($a)) return null;
                return [
                    'id' => $a['id'] ?? null,
                    'title' => $a['title'] ?? null,
                    'reason' => $a['reason'] ?? null,
                ];
            }, $alts))) : [],
        ];
    }

    private function extractBestPortfolioId(string $text): ?string
    {
        $patterns = [
            '/\bP\d{2,4}-X\d{1,4}(?:-C\d{1,4})?\b/i',
            '/\bP\d{2,4}\b/i',
            '/\bPXO?\d{2,4}\b/i',
        ];
        foreach ($patterns as $p) {
            if (preg_match($p, $text, $m)) {
                return strtoupper((string) $m[0]);
            }
        }
        return null;
    }

    /** @return string[] */
    private function extractAlternativeIds(string $context, string $exclude = ''): array
    {
        preg_match_all('/\bP\d{2,4}(?:-X\d{1,4}(?:-C\d{1,4})?)?\b/i', $context, $m);
        $ids = array_values(array_unique(array_map('strtoupper', $m[0] ?? [])));
        if ($exclude !== '') {
            $ids = array_values(array_filter($ids, fn($id) => strtoupper($id) !== strtoupper($exclude)));
        }
        return array_slice($ids, 0, 3);
    }
}

