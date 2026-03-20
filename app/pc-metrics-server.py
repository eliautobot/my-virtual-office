#!/usr/bin/env python3
"""
PC Performance Metrics Server
Runs on the Windows PC, exposes CPU/RAM/GPU stats via HTTP JSON endpoint.
Install: pip install psutil flask
GPU: requires nvidia-smi on PATH
"""

import json
import subprocess
import time
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
import sys

try:
    import psutil
except ImportError:
    print("ERROR: pip install psutil")
    sys.exit(1)

# Cache metrics, update every 2 seconds
_metrics = {}
_lock = threading.Lock()

_nvml_inited = False
try:
    import pynvml
    pynvml.nvmlInit()
    _nvml_inited = True
except Exception:
    pass

def get_gpu_stats():
    """Query GPUs via pynvml for utilization, memory, temp, power."""
    gpus = []
    if not _nvml_inited:
        return gpus
    try:
        count = pynvml.nvmlDeviceGetCount()
        for i in range(count):
            handle = pynvml.nvmlDeviceGetHandleByIndex(i)
            name = pynvml.nvmlDeviceGetName(handle)
            if isinstance(name, bytes):
                name = name.decode()
            util = pynvml.nvmlDeviceGetUtilizationRates(handle)
            mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
            temp = pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)
            # Power in milliwatts
            try:
                power_mw = pynvml.nvmlDeviceGetPowerUsage(handle)
                power_w = round(power_mw / 1000, 1)
            except Exception:
                power_w = 0
            try:
                power_limit_mw = pynvml.nvmlDeviceGetPowerManagementLimit(handle)
                power_limit_w = round(power_limit_mw / 1000, 1)
            except Exception:
                power_limit_w = 0
            gpus.append({
                "index": i,
                "name": name,
                "utilization": util.gpu,
                "memoryUsedMB": round(mem.used / (1024**2), 1),
                "memoryTotalMB": round(mem.total / (1024**2), 1),
                "tempC": temp,
                "powerW": power_w,
                "powerLimitW": power_limit_w
            })
    except Exception:
        pass
    return gpus

def collect_metrics():
    """Collect all system metrics."""
    cpu_percent = psutil.cpu_percent(interval=1)
    cpu_freq = psutil.cpu_freq()
    cpu_count = psutil.cpu_count()
    cpu_count_logical = psutil.cpu_count(logical=True)
    
    mem = psutil.virtual_memory()
    
    # Per-core CPU
    per_cpu = psutil.cpu_percent(interval=0, percpu=True)
    
    # Disk
    disk = psutil.disk_usage('/')
    
    # Network (bytes since boot)
    net = psutil.net_io_counters()
    
    gpus = get_gpu_stats()
    
    return {
        "timestamp": time.time(),
        "cpu": {
            "percent": cpu_percent,
            "perCore": per_cpu,
            "freqMHz": cpu_freq.current if cpu_freq else 0,
            "freqMaxMHz": cpu_freq.max if cpu_freq else 0,
            "cores": cpu_count,
            "threads": cpu_count_logical
        },
        "memory": {
            "percent": mem.percent,
            "usedGB": round(mem.used / (1024**3), 1),
            "totalGB": round(mem.total / (1024**3), 1),
            "availableGB": round(mem.available / (1024**3), 1)
        },
        "gpus": gpus,
        "disk": {
            "percent": disk.percent,
            "usedGB": round(disk.used / (1024**3), 1),
            "totalGB": round(disk.total / (1024**3), 1)
        },
        "network": {
            "sentMB": round(net.bytes_sent / (1024**2), 1),
            "recvMB": round(net.bytes_recv / (1024**2), 1)
        }
    }

def metrics_loop():
    """Background thread that updates metrics every 2 seconds."""
    global _metrics
    while True:
        try:
            data = collect_metrics()
            with _lock:
                _metrics = data
        except Exception as e:
            print(f"Metrics error: {e}")
        time.sleep(2)

class MetricsHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/metrics" or self.path == "/":
            with _lock:
                data = _metrics
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        else:
            self.send_response(404)
            self.end_headers()
    
    def log_message(self, format, *args):
        pass  # Suppress request logs

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
    
    # Start metrics collection thread
    t = threading.Thread(target=metrics_loop, daemon=True)
    t.start()
    
    # Wait for first collection
    time.sleep(2)
    
    server = HTTPServer(("0.0.0.0", port), MetricsHandler)
    print(f"PC Metrics Server running on port {port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.server_close()
