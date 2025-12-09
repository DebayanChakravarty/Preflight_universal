/**
 * ✈️ PREFLIGHT API INTEGRATION CONNECTOR
 * =====================================
 * This file serves as the bridge between the Client-Side Preflight Validator
 * and your Server-Side Infrastructure.
 * 
 * TODO:
 * 1. Replace API_ENDPOINT with your actual upload URL.
 * 2. Add any required headers (Authorization, X-API-Key, etc.).
 * 3. Import this function into 'core/shell.js' when you are ready to go live.
 */

const API_CONFIG = {
    // Replace this with your actual backend endpoint
    ENDPOINT: "https://api.your-company.com/v1/ingest/files",

    // Optional: Add Auth tokens structure
    HEADERS: {
        // "Authorization": "Bearer <YOUR_TOKEN>",
        // "X-Custom-Auth": "SecretKey"
    }
};

/**
 * Uploads a validated file to the backend.
 * 
 * @param {File} file - The raw file object from the drop zone.
 * @param {Object} metadata - Quality data (Score, Plugin Tag, Validation Msg).
 * @returns {Promise<Object>} - The JSON response from your server.
 */
export async function uploadToBackend(file, metadata) {
    console.log(`🚀 Starting Upload: ${file.name}`);
    console.log(`📊 Quality Score: ${metadata.score}/100 [${metadata.tag}]`);

    const formData = new FormData();
    formData.append("document", file);

    // Sending Preflight "Metadata" headers allows your server to 
    // prioritize or route files based on quality before processing.
    formData.append("preflight_score", metadata.score);
    formData.append("preflight_valid", metadata.valid);
    formData.append("preflight_tag", metadata.tag); // e.g., 'xray-plus', 'doc-ocr'

    try {
        const response = await fetch(API_CONFIG.ENDPOINT, {
            method: "POST",
            headers: {
                ...API_CONFIG.HEADERS,
                // Note: Content-Type is set automatically by the browser for FormData
            },
            body: formData
        });

        if (!response.ok) {
            throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        console.log("✅ Upload Successful:", data);
        return data;

    } catch (error) {
        console.error("❌ Upload Failed:", error);
        // Re-throw to handle UI error states in shell.js
        throw error;
    }
}
