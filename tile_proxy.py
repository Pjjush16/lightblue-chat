#!/usr/bin/env python3
"""
天地图瓦片代理服务器
模拟 Tauri Rust 后端的 fetch_tile 命令：
- 接收前端请求
- 向后端 Tianditu 服务器请求瓦片（不发送 Referer/Origin 头）
- 返回瓦片数据给前端
这解决了服务端类型 Key 在浏览器中被 403 拒绝的问题
"""

import http.server
import json
import urllib.request
import urllib.error
import sys

PORT = 8090
TIANDITU_KEY = os.environ.get("TIANDITU_KEY", "")

class TileProxyHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        # Parse query params from path like /tile?layer=img_c&x=104&y=52&z=7
        if self.path.startswith('/tile'):
            params = {}
            if '?' in self.path:
                query = self.path.split('?', 1)[1]
                for pair in query.split('&'):
                    k, v = pair.split('=', 1)
                    params[k] = v
            
            layer = params.get('layer', 'img_c')
            x = params.get('x', '0')
            y = params.get('y', '0')
            z = params.get('z', '1')
            
            server = int(x) % 8
            url = f"http://t{server}.tianditu.gov.cn/DataServer?T={layer}&X={x}&Y={y}&L={z}&tk={TIANDITU_KEY}"
            
            try:
                # Make request WITHOUT Referer/Origin headers (key point of the fix)
                req = urllib.request.Request(url)
                req.add_header('User-Agent', 'TiandituClient/1.0')
                # Deliberately NOT adding Referer or Origin
                # User-Agent must NOT contain "Mozilla" or Tianditu returns 403
                
                with urllib.request.urlopen(req, timeout=10) as resp:
                    data = resp.read()
                    content_type = resp.headers.get('Content-Type', 'image/jpeg')
                    
                    self.send_response(200)
                    self.send_header('Content-Type', content_type)
                    self.send_header('Content-Length', str(len(data)))
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.send_header('Cache-Control', 'max-age=86400')
                    self.end_headers()
                    self.wfile.write(data)
                    self.log_message(f"OK {layer} X={x} Y={y} Z={z} ({len(data)}B)")
                    
            except urllib.error.HTTPError as e:
                body = e.read()
                self.send_response(e.code)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(body)
                self.log_message(f"FAIL {layer} X={x} Y={y} Z={z}: {e.code} {body.decode()[:100]}")
                
            except Exception as e:
                self.send_response(502)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
                self.log_message(f"ERROR {layer} X={x} Y={y} Z={z}: {e}")
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        print(f"[TileProxy] {format}" % args, flush=True)

if __name__ == '__main__':
    server = http.server.HTTPServer(('127.0.0.1', PORT), TileProxyHandler)
    print(f"Tile proxy running on http://127.0.0.1:{PORT}")
    print(f"Usage: GET /tile?layer=img_c&x=104&y=52&z=7")
    server.serve_forever()
