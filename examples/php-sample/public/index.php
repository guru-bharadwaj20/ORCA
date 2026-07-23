<?php
// A minimal PHP endpoint served by the built-in server over public/ — the smallest repo
// that exercises ORCA's php-composer recipe (no framework, no external packages).
header('Content-Type: application/json');
echo json_encode(['status' => 'ok', 'service' => 'orca-php-sample']);
