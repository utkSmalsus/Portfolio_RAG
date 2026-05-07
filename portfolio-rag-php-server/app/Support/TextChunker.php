<?php

namespace App\Support;

class TextChunker
{
    /** @return string[] */
    public static function chunk(string $text, int $size = 4000, int $overlap = 400): array
    {
        $t = trim(preg_replace('/\s+/', ' ', $text) ?? '');
        if ($t === '') return [];

        $chunks = [];
        $len = strlen($t);
        $start = 0;
        while ($start < $len) {
            $end = min($len, $start + $size);
            $chunks[] = trim(substr($t, $start, $end - $start));
            if ($end >= $len) break;
            $start = max(0, $end - $overlap);
        }
        return array_values(array_filter($chunks));
    }
}

