<?php

use Illuminate\Support\Facades\Route;

Route::get('/health', [\App\Http\Controllers\Api\HealthController::class, 'show']);

Route::get('/debug/pdfparser', function () {
    $autoload = base_path('vendor/autoload.php');
    if (is_file($autoload)) {
        require_once $autoload;
    }
    return response()->json([
        'base_path' => base_path(),
        'autoload' => $autoload,
        'autoload_exists' => is_file($autoload),
        'parser_exists' => class_exists(\Smalot\PdfParser\Parser::class),
    ]);
});

Route::get('/collection', [\App\Http\Controllers\Api\PortfolioController::class, 'collection']);
Route::delete('/collection', [\App\Http\Controllers\Api\PortfolioController::class, 'deleteCollection']);
Route::post('/index', [\App\Http\Controllers\Api\PortfolioController::class, 'index']);

Route::post('/unified/chat', [\App\Http\Controllers\Api\UnifiedChatController::class, 'chat']);

Route::prefix('transcript')->group(function () {
    Route::get('/collection', [\App\Http\Controllers\Api\TranscriptController::class, 'collection']);
    Route::delete('/collection', [\App\Http\Controllers\Api\TranscriptController::class, 'deleteCollection']);
    Route::post('/index', [\App\Http\Controllers\Api\TranscriptController::class, 'index']);
    Route::post('/chat', [\App\Http\Controllers\Api\TranscriptController::class, 'chat']);
    Route::post('/feedback', [\App\Http\Controllers\Api\TranscriptController::class, 'feedback']);
});

