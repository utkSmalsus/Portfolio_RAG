<?php

namespace App\Services;

use PhpOffice\PhpWord\IOFactory;
use Smalot\PdfParser\Parser;
use ZipArchive;

class DocumentTextExtractor
{
    public function extractPdf(string $path): string
    {
        // Defensive: in some dev setups the running server process can have stale autoload state.
        // Force-load Composer autoload if the class isn't available yet.
        if (!class_exists(Parser::class)) {
            $autoload = base_path('vendor/autoload.php');
            if (is_file($autoload)) {
                require_once $autoload;
            }
        }
        if (!class_exists(Parser::class)) {
            throw new \RuntimeException('PDF parser dependency missing. Run `composer install` in portfolio-rag-php-server.');
        }

        $parser = new Parser();
        $pdf = $parser->parseFile($path);
        return (string) $pdf->getText();
    }

    public function extractDocx(string $path): string
    {
        try {
            $phpWord = IOFactory::load($path);
            $text = '';
            foreach ($phpWord->getSections() as $section) {
                foreach ($section->getElements() as $el) {
                    if (method_exists($el, 'getText')) {
                        $text .= $el->getText()."\n";
                    } elseif (method_exists($el, 'getElements')) {
                        foreach ($el->getElements() as $child) {
                            if (method_exists($child, 'getText')) $text .= $child->getText()."\n";
                        }
                    }
                }
            }
            return $text;
        } catch (\Throwable) {
            // Fallback for DOCX files that phpword cannot parse due to style/value quirks
            // (e.g., "A non-numeric value encountered" in reader internals).
            $zip = new ZipArchive();
            if ($zip->open($path) !== true) {
                return '';
            }
            $xml = $zip->getFromName('word/document.xml') ?: '';
            $zip->close();
            if ($xml === '') return '';
            $plain = strip_tags(str_replace(['</w:p>', '</w:tr>', '</w:br>'], ["\n", "\n", "\n"], $xml));
            return trim(preg_replace('/\s+/', ' ', $plain) ?? '');
        }
    }
}

