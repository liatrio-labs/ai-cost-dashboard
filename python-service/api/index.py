import os
import sys

# Ensure the service root (python-service) is importable.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from vercel_app import app  # noqa: E402  (ASGI app Vercel will serve)
