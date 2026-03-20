#!/usr/bin/env python3
"""Lightweight Whisper transcription server for Virtual Office chat."""
import http.server
import json
import tempfile
import os
import io

PORT = 8087

# Lazy-load model on first request
_model = None

def get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        # Use small model for speed — runs on CPU
        _model = WhisperModel("small", device="cpu", compute_type="int8")
        print(f"[whisper] Model loaded")
    return _model


class Handler(http.server.BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_POST(self):
        if self.path != "/transcribe":
            self.send_response(404)
            self.end_headers()
            return

        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0 or content_length > 25 * 1024 * 1024:  # 25MB max
            self._json_response(400, {"error": "Invalid content length"})
            return

        audio_data = self.rfile.read(content_length)

        try:
            # Write to temp file (faster-whisper needs a file path)
            with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as f:
                f.write(audio_data)
                tmp_path = f.name

            model = get_model()
            segments, info = model.transcribe(tmp_path, language=None, beam_size=5)
            text = " ".join(seg.text.strip() for seg in segments)

            os.unlink(tmp_path)

            self._json_response(200, {
                "text": text,
                "language": info.language,
                "duration": round(info.duration, 1)
            })
        except Exception as e:
            self._json_response(500, {"error": str(e)})
            if 'tmp_path' in locals():
                try: os.unlink(tmp_path)
                except: pass

    def _json_response(self, code, data):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def log_message(self, format, *args):
        print(f"[whisper] {args[0]}")


if __name__ == "__main__":
    server = http.server.HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[whisper] Transcription server on port {PORT}")
    server.serve_forever()
