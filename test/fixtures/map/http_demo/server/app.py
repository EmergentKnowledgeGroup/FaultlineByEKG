from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/api/items':
            self.send_items()
        elif path == '/api/health':
            self.send_ok()

    def send_items(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'[]')

    def send_ok(self):
        self.send_response(204)
        self.end_headers()
