<?php

namespace App\Contracts\GeoFlow;

use App\Data\Ai\SystemAiIdentity;
use App\Models\AiVisibilityRun;

interface AiVisibilityCollector
{
    /**
     * @return array<string, AiVisibilityRun>
     */
    public function collect(SystemAiIdentity $identity, string $keyword): array;
}
