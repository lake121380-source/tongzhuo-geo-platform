<?php

namespace App\Http\Requests\Admin;

use App\Models\Admin;
use App\Support\ManualPublicationSettingsRules;
use Illuminate\Foundation\Http\FormRequest;

class SaveManualPublicationPersonaRequest extends FormRequest
{
    public function authorize(): bool
    {
        $admin = $this->user('admin');

        return $admin instanceof Admin && $admin->isSuperAdmin();
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return ManualPublicationSettingsRules::persona();
    }
}
