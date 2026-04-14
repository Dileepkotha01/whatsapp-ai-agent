<?php
/**
 * Secure Image Uploader API
 * Send a POST request with the file using multipart/form-data.
 * Authentication token required for security.
 */

header('Content-Type: application/json');

// Security Token (CHANGE THIS TO MATCH YOUR NODE SERVER!)
$SECRET_TOKEN = 'ekaralu_secure_upload_999!';

if (!isset($_SERVER['HTTP_X_UPLOAD_TOKEN']) || $_SERVER['HTTP_X_UPLOAD_TOKEN'] !== $SECRET_TOKEN) {
    http_response_code(403);
    echo json_encode(["success" => false, "error" => "Unauthorized token."]);
    exit;
}

if (!isset($_FILES['image'])) {
    http_response_code(400);
    echo json_encode(["success" => false, "error" => "No image file provided."]);
    exit;
}

$file = $_FILES['image'];
$uploadDir = __DIR__ . '/uploads/';

// Ensure uploads folder exists
if (!is_dir($uploadDir)) {
    mkdir($uploadDir, 0755, true);
}

// Security: Check valid image extensions
$allowedExts = ['jpg', 'jpeg', 'png'];
$ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));

if (!in_array($ext, $allowedExts)) {
    http_response_code(400);
    echo json_encode(["success" => false, "error" => "Invalid file format."]);
    exit;
}

// Generate secure filename
$filename = uniqid('prop_') . '_' . time() . '.' . $ext;
$destination = $uploadDir . $filename;

if (move_uploaded_file($file['tmp_name'], $destination)) {
    echo json_encode([
        "success" => true, 
        "filename" => $filename,
        "url" => "https://api.ekaralu.com/uploads/" . $filename
    ]);
} else {
    http_response_code(500);
    echo json_encode(["success" => false, "error" => "File upload failed."]);
}
?>
