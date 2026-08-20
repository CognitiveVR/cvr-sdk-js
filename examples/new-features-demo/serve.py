#!/usr/bin/env python3
import http.server
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
    os.chdir(ROOT)
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    with http.server.ThreadingHTTPServer(('127.0.0.1', port), NoCacheHandler) as httpd:
        print('serving %s' % ROOT)
        print('demo at http://127.0.0.1:%d/examples/new-features-demo/demo.html' % port)
        sys.stdout.flush()
        httpd.serve_forever()


if __name__ == '__main__':
    main()
